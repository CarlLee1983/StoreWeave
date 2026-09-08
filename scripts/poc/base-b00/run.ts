import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { Database } from '../../../packages/platform/db/src/client';
import { runMigrations } from '../../../packages/platform/db/src/migrator';
import { platformMigrations } from '../../../packages/platform/db/src/migrations/platform';
import { JobQueue } from '../../../packages/platform/jobs/src/jobs';
import { RecurringScheduler } from '../../../packages/platform/kernel/src/recurring';
import { noopLogger } from '../../../packages/platform/contracts/src/logger';
import { PgBoss, fromDrizzle, getRollbackPlans } from 'pg-boss';
import { PgBoss as PreviousBoss } from 'pg-boss-previous';
import Timekeeper from './node_modules/pg-boss/dist/timekeeper.js';

// This is a characterization experiment. A completed probe can expose an unmet target;
// unmetTargets is deliberately separate from execution/assertion failures.
const results: { candidate: string; case: string; observed: unknown; unmetTargets: string[] }[] = [];
function record(candidate: string, name: string, observed: unknown, unmetTargets: string[] = []) {
  results.push({ candidate, case: name, observed, unmetTargets });
  console.log(`${candidate}: ${name} — probe complete; target gaps ${unmetTargets.length}`);
}
async function killAfterClaim(candidate: string, url: string, expectedId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./crash-worker.ts', import.meta.url)), candidate], {
    env: { ...process.env, B00_PG_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Crash worker did not claim within 20 seconds')), 20_000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timeout); resolve(); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Crash worker exited before claim')); });
    });
    assert.equal(JSON.parse(output.trim()).claimed, expectedId);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

const container = await new PostgreSqlContainer('postgres:17-alpine')
  .withDatabase('b00').withUsername('b00').withPassword('b00').start();
let database: Database | undefined;
const queue = new JobQueue();
const enqueue = (input: Parameters<JobQueue['enqueue']>[1]) => database!.transaction(tx => queue.enqueue(tx, { runAt: new Date(0), ...input }));
const claim = (owner: string, type: string) => database!.transaction(tx => queue.claim(tx, owner, 1, [type]));
const row = async (id: string) => (await database!.pool.query('SELECT * FROM platform_jobs WHERE id=$1', [id])).rows[0];
let boss: PgBoss | undefined;
let previous: PreviousBoss | undefined;
const errors: string[] = [];
const options = { connectionString: container.getConnectionUri(), schema: 'b00_boss', supervise: false, schedule: false, bamIntervalSeconds: 10 };
let serverVersion: string;
async function finishBam() {
  for (let attempt = 0; attempt < 800; attempt++) {
    const entries = await boss!.getBamEntries();
    assert(!entries.some(entry => entry.status === 'failed'), JSON.stringify(entries));
    if (entries.every(entry => entry.status === 'completed')) return entries.length;
    await delay(100);
  }
  throw new Error('BAM did not finish within 80 seconds');
}

try {
  database = new Database({ url: container.getConnectionUri(), poolSize: 1 });
  if (process.argv.includes('--fail-setup')) {
    await database.pool.query('SELECT b00_intentional_missing_function()');
  }
  serverVersion = (await database.pool.query('SHOW server_version')).rows[0].server_version;
  // Use actual old platform migration, then the complete current set; no copied schema.
  await runMigrations(database.pool, [{ ...platformMigrations, migrations: platformMigrations.migrations.slice(0, 1) }]);
  await database.pool.query('CREATE TABLE poc_domain (id text PRIMARY KEY)');
  let rolledBack = '';
  await assert.rejects(database.transaction(async tx => {
    await tx.execute(sql`INSERT INTO poc_domain VALUES ('current-rollback')`);
    rolledBack = (await queue.enqueue(tx, { type: 'poc.tx', payload: { version: 1 }, dedupeKey: 'rollback' })).id;
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert.equal(await row(rolledBack), undefined);
  assert.equal((await database.pool.query("SELECT * FROM poc_domain WHERE id='current-rollback'")).rowCount, 0);
  const committed = await database.transaction(async tx => {
    await tx.execute(sql`INSERT INTO poc_domain VALUES ('current-commit')`);
    return queue.enqueue(tx, { type: 'poc.tx', payload: { version: 1 } });
  });
  assert.equal((await row(committed.id)).status, 'pending');
  assert.equal((await database.pool.query("SELECT * FROM poc_domain WHERE id='current-commit'")).rowCount, 1);
  record('current', 'transaction', { rollbackRemovedDomainAndJob: true, committedJobVisible: true });

  const concurrent = new Database({ url: container.getConnectionUri(), poolSize: 4 });
  let dedupe;
  try {
    dedupe = await Promise.all(Array.from({ length: 4 }, () => concurrent.transaction(tx => queue.enqueue(tx, { type: 'poc.dedupe', payload: {}, dedupeKey: 'same', runAt: new Date(0) }))));
  } finally { await concurrent.close(); }
  assert.equal(dedupe.filter(x => !x.deduped).length, 1);
  const durable = await queue.findByDedupeKey(database.db, 'same');
  assert(durable);
  assert.equal((await database.pool.query("SELECT * FROM platform_jobs WHERE dedupe_key='same'")).rowCount, 1);
  assert.equal(new Set(dedupe.map(x => x.id)).size, 4);
  await claim('dedupe-owner', 'poc.dedupe');
  await queue.complete(database.db, durable.id, 'dedupe-owner');
  assert.equal((await enqueue({ type: 'poc.dedupe', payload: {}, dedupeKey: 'same' })).deduped, true);
  record('current', 'dedupe', { rows: 1, returnedIds: 4, durableIdentityReturnedOnConflict: false, completedRowStillDedupes: true }, ['Return existing durable identity on conflict', 'Define retention/dedupe horizon']);

  const original = await enqueue({ type: 'poc.replace', payload: { version: 1 }, dedupeKey: 'replace' });
  assert.equal((await claim('owner-a', 'poc.replace'))[0].id, original.id);
  const replacement = await enqueue({ type: 'poc.replace', payload: { version: 2 }, dedupeKey: 'replace', replaceExisting: true });
  assert.equal(replacement.id, original.id);
  assert.equal((await claim('owner-b', 'poc.replace'))[0].id, original.id);
  await queue.complete(database.db, original.id, 'owner-a');
  assert.equal((await row(original.id)).status, 'running');
  await queue.complete(database.db, original.id, 'owner-b');
  record('current', 'running replacement', { sameIdentity: true, overlapsOldAttempt: true, differentOwnerGuard: true }, ['Defer replacement until old attempt is fenced/drained', 'Use occurrence generation rather than worker id alone']);

  const crashed = await enqueue({ type: 'poc.crash', payload: {}, maxAttempts: 1 });
  await killAfterClaim('current', container.getConnectionUri(), crashed.id);
  await database.pool.query("UPDATE platform_jobs SET locked_at=now()-interval '2 minutes' WHERE id=$1", [crashed.id]);
  assert.equal(await queue.reclaimStale(database.db, 60), 1);
  const reclaimed = (await claim('crashed-owner', 'poc.crash'))[0];
  assert.equal(reclaimed.attempts, 2);
  await queue.complete(database.db, crashed.id, 'crashed-owner');
  assert.equal((await row(crashed.id)).status, 'completed');
  record('current', 'crash lease', { processKilledAfterClaim: true, reclaimed: true, attempts: 2, maxAttempts: 1, staleSameOwnerCompletionAccepted: true }, ['Per-attempt fencing and heartbeat', 'Bound crash-only retries by maxAttempts']);

  const dead = await enqueue({ type: 'poc.dead', payload: { version: 1 }, dedupeKey: 'dead', maxAttempts: 1 });
  const deadClaim = (await claim('dead-owner', 'poc.dead'))[0];
  assert.equal(await queue.fail(database.db, deadClaim, 'expected failure', false, 'dead-owner'), 'dead');
  await queue.retryDead(database.db, dead.id);
  assert.equal((await row(dead.id)).attempts, 0);
  await assert.rejects(queue.retryDead(database.db, dead.id));
  assert.equal((await claim('retry-owner', 'poc.dead'))[0].id, dead.id);
  await queue.complete(database.db, dead.id, 'retry-owner');
  await assert.rejects(queue.retryDead(database.db, dead.id));
  record('current', 'DLQ retry', { preservedId: true, resetAttempts: true, repeatedRetryRejected: true, completed: true });

  const scheduler = new RecurringScheduler({ jobs: queue, database, logger: noopLogger });
  scheduler.register({ type: 'poc.daily', everyMs: 86_400_000 });
  await scheduler.ensureScheduled(new Date('2026-03-07T16:00:30Z'));
  await scheduler.ensureScheduled(new Date('2026-03-10T16:00:30Z'));
  const scheduled = (await database.pool.query("SELECT payload FROM platform_jobs WHERE type='poc.daily' ORDER BY run_at")).rows;
  assert.deepEqual(scheduled.map(x => x.payload.scheduledFor), ['2026-03-07T00:00:00.000Z', '2026-03-10T00:00:00.000Z']);
  record('current', 'schedule timezone', { scheduledFor: scheduled.map(x => x.payload.scheduledFor), missedDaysSkipped: 2 }, ['Cron and IANA timezone/DST', 'Explicit misfire policies, pause and overlap control']);

  for (const status of ['pending', 'running', 'dead']) {
    const seeded = await enqueue({ type: 'poc.upgrade', payload: { status, version: 1 }, dedupeKey: `upgrade-${status}` });
    await database.pool.query('UPDATE platform_jobs SET status=$2, attempts=2, last_error=$3 WHERE id=$1', [seeded.id, status, status === 'dead' ? 'preserve error' : null]);
  }
  const snapshot = () => database!.pool.query("SELECT id,status,payload,attempts,max_attempts,dedupe_key,last_error,locked_at,locked_by FROM platform_jobs WHERE type='poc.upgrade' ORDER BY id");
  const before = (await snapshot()).rows;
  assert.deepEqual(await runMigrations(database.pool, [platformMigrations]), ['platform/0002_worker_heartbeat']);
  assert.deepEqual(await runMigrations(database.pool, [platformMigrations]), []);
  assert.deepEqual((await snapshot()).rows, before);
  record('current', 'schema upgrade', { from: 'platform/0001_init', to: 'platform/0002_worker_heartbeat', preservedStates: ['pending', 'running', 'dead'], repeatNoop: true }, ['No historical queue schema change to prove a queue data conversion', 'Checksums/order/unknown-history validation belongs to B02']);

  previous = new PreviousBoss(options);
  previous.on('error', error => errors.push(error.message));
  await previous.start();
  assert.equal(await previous.schemaVersion(), 39);
  await previous.createQueue('poc-upgrade', { retryLimit: 0 });
  await previous.createQueue('poc-upgrade-partition', { partition: true });
  await previous.send('poc-upgrade-partition', { version: 1 });
  await previous.createQueue('poc-upgrade-retry', { retryLimit: 2, retryDelay: 3600 });
  const retrySeed = await previous.send('poc-upgrade-retry', { version: 1 }, { singletonKey: 'upgrade-retry' }); assert(retrySeed);
  await previous.fetch('poc-upgrade-retry');
  await previous.fail('poc-upgrade-retry', retrySeed, { message: 'preserve retry error' });
  assert.equal((await previous.findJobs('poc-upgrade-retry', { id: retrySeed }))[0].state, 'retry');
  await previous.createQueue('poc-upgrade-dlq');
  await previous.createQueue('poc-upgrade-dlq-source', { retryLimit: 0, deadLetter: 'poc-upgrade-dlq' });
  const dlqSeed = await previous.send('poc-upgrade-dlq-source', { version: 1 }); assert(dlqSeed);
  await previous.fetch('poc-upgrade-dlq-source');
  await previous.fail('poc-upgrade-dlq-source', dlqSeed, { message: 'preserve DLQ error' });
  assert.equal((await previous.findJobs('poc-upgrade-dlq'))[0].sourceId, dlqSeed);
  const upgradeIds = [];
  for (const state of ['active', 'failed', 'completed', 'created']) {
    const id: string | null = await previous.send('poc-upgrade', { state, version: 1 }, { singletonKey: `upgrade-${state}` });
    assert(id); upgradeIds.push(id);
    if (state !== 'created') {
      assert.equal((await previous.fetch('poc-upgrade'))[0].id, id);
      if (state === 'failed') await previous.fail('poc-upgrade', id, { message: 'preserve error' });
      if (state === 'completed') await previous.complete('poc-upgrade', id);
    }
  }
  const bossSnapshot = () => database!.pool.query("SELECT * FROM b00_boss.job WHERE name LIKE 'poc-upgrade%' ORDER BY id");
  const oldRows = (await bossSnapshot()).rows;
  await previous.stop(); previous = undefined;
  boss = new PgBoss(options);
  boss.on('error', error => errors.push(error.message));
  await boss.start();
  assert.equal(await boss.schemaVersion(), 40);
  assert.deepEqual((await bossSnapshot()).rows, oldRows);
  const bamCommands = await finishBam();
  const drift = await boss.detectSchemaDrift();
  assert.equal(drift.ok, true, JSON.stringify(drift));
  await boss.stop(); await boss.start();
  assert.equal(await boss.schemaVersion(), 40);
  assert.deepEqual((await bossSnapshot()).rows, oldRows);
  await boss.stop();
  await database.pool.query(getRollbackPlans('b00_boss', 40));
  previous = new PreviousBoss({ ...options, migrate: false });
  previous.on('error', error => errors.push(error.message));
  await previous.start();
  assert.equal(await previous.schemaVersion(), 39);
  assert.deepEqual((await bossSnapshot()).rows, oldRows);
  await previous.createQueue('poc-rollback-control');
  const rollbackControl = await previous.send('poc-rollback-control', {}); assert(rollbackControl);
  assert.equal((await previous.fetch('poc-rollback-control'))[0].id, rollbackControl);
  await previous.complete('poc-rollback-control', rollbackControl);
  await previous.stop(); previous = undefined;
  await boss.start();
  await finishBam();
  assert.equal(await boss.schemaVersion(), 40);
  assert.deepEqual((await bossSnapshot()).rows, oldRows);
  const upgradedClaim = (await boss.fetch('poc-upgrade-partition'))[0];
  assert(upgradedClaim);
  await boss.complete('poc-upgrade-partition', upgradedClaim.id);
  assert.equal(await boss.redrive('poc-upgrade-dlq'), 1);
  const upgradedDlq = (await boss.fetch('poc-upgrade-dlq-source'))[0]; assert(upgradedDlq);
  await boss.complete('poc-upgrade-dlq-source', upgradedDlq.id);
  record('pg-boss', 'schema upgrade', { from: 39, to: 40, preservedStates: [...new Set(oldRows.map(x => x.state))].sort(), retryAndDlqRowsPreserved: true, partitionedQueue: true, bamCommands, driftOk: true, repeatStartPreservedRows: true, rollbackTo39AndReupgrade: true, oldBinaryCompletedAfterRollback: true, postUpgradeCompleted: true, upgradedDlqRedrivenAndCompleted: true });

  await boss.createQueue('poc-tx');
  let bossRollback: string | null = null;
  await assert.rejects(database.transaction(async tx => {
    await tx.execute(sql`INSERT INTO poc_domain VALUES ('boss-rollback')`);
    bossRollback = await boss!.send('poc-tx', { version: 1 }, { db: fromDrizzle(tx, sql) });
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert(bossRollback);
  assert.equal((await boss.findJobs('poc-tx', { id: bossRollback })).length, 0);
  assert.equal((await database.pool.query("SELECT * FROM poc_domain WHERE id='boss-rollback'")).rowCount, 0);
  const bossCommit = await database.transaction(async tx => {
    await tx.execute(sql`INSERT INTO poc_domain VALUES ('boss-commit')`);
    return boss!.send('poc-tx', { version: 1 }, { db: fromDrizzle(tx, sql) });
  });
  assert(bossCommit);
  assert.equal((await boss.findJobs('poc-tx', { id: bossCommit })).length, 1);
  assert.equal((await database.pool.query("SELECT * FROM poc_domain WHERE id='boss-commit'")).rowCount, 1);
  record('pg-boss', 'transaction', { actualDrizzleAdapter: true, rollbackRemovedDomainAndJob: true, committedJobVisible: true });

  await boss.createQueue('poc-dedupe', { policy: 'exclusive' });
  const sent = await Promise.all(Array.from({ length: 4 }, () => boss!.send('poc-dedupe', {}, { singletonKey: 'same' })));
  assert.equal(sent.filter(Boolean).length, 1);
  assert.equal((await boss.findJobs('poc-dedupe', { key: 'same' })).length, 1);
  const preActiveUpsert = await boss.upsert('poc-dedupe', {}, { singletonKey: 'same' });
  assert.equal(preActiveUpsert.jobs[0], sent.find(Boolean));
  await boss.fetch('poc-dedupe');
  await boss.complete('poc-dedupe', sent.find(Boolean)!);
  assert(await boss.send('poc-dedupe', {}, { singletonKey: 'same' }));
  record('pg-boss', 'dedupe', { rowsBeforeCompletion: 1, nullConflictResults: sent.filter(x => x === null).length, preActiveUpsertReturnsIdentity: true, completedRowStillDedupes: false }, ['Return existing durable identity on conflict', 'Define retention/dedupe horizon']);

  await boss.createQueue('poc-replace', { policy: 'exclusive' });
  const bossOriginal = await boss.send('poc-replace', { version: 1 }, { singletonKey: 'replace' });
  assert(bossOriginal);
  await boss.fetch('poc-replace');
  const update = await boss.update('poc-replace', { version: 2 }, { singletonKey: 'replace' });
  assert.equal(update.updated, 0);
  assert.deepEqual((await boss.findJobs('poc-replace', { id: bossOriginal }))[0].data, { version: 1 });
  const upsert = await boss.upsert('poc-replace', { version: 2 }, { singletonKey: 'replace' });
  assert.equal(upsert.inserted, 0);
  record('pg-boss', 'running replacement', { update, upsert, originalPayloadPreserved: true }, ['Active replacement requires application-level deferred occurrence contract']);

  await boss.createQueue('poc-crash', { retryLimit: 1, retryDelay: 0, expireInSeconds: 1 });
  const bossCrashed = await boss.send('poc-crash', {}); assert(bossCrashed);
  await killAfterClaim('pg-boss', container.getConnectionUri(), bossCrashed);
  await database.pool.query("UPDATE b00_boss.job SET started_on=now()-interval '2 minutes' WHERE id=$1", [bossCrashed]);
  await boss.supervise('poc-crash');
  const bossReclaimed = await boss.fetch('poc-crash', { includeMetadata: true });
  assert.equal(bossReclaimed[0]?.id, bossCrashed);
  await boss.complete('poc-crash', bossCrashed);
  assert.equal((await boss.findJobs('poc-crash', { id: bossCrashed }))[0].state, 'completed');
  await boss.createQueue('poc-heartbeat', { heartbeatSeconds: 10, expireInSeconds: 600, retryLimit: 0 });
  const live = await boss.send('poc-heartbeat', {}); assert(live);
  await boss.fetch('poc-heartbeat');
  await database.pool.query("UPDATE b00_boss.job SET heartbeat_on=now()-interval '1 minute' WHERE id=$1", [live]);
  await boss.touch('poc-heartbeat', live);
  await boss.supervise('poc-heartbeat');
  assert.equal((await boss.findJobs('poc-heartbeat', { id: live }))[0].state, 'active');
  await database.pool.query("UPDATE b00_boss.job SET heartbeat_on=now()-interval '1 minute' WHERE id=$1", [live]);
  await database.pool.query("UPDATE b00_boss.queue SET monitor_claim_on=NULL WHERE name='poc-heartbeat'");
  await boss.supervise('poc-heartbeat');
  assert.equal((await boss.findJobs('poc-heartbeat', { id: live }))[0].state, 'failed');
  await boss.createQueue('poc-crash-exhaust', { retryLimit: 1, retryDelay: 0, expireInSeconds: 1 });
  const exhausted = await boss.send('poc-crash-exhaust', {}); assert(exhausted);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await boss.fetch('poc-crash-exhaust'))[0].id, exhausted);
    await database.pool.query("UPDATE b00_boss.job SET started_on=now()-interval '2 minutes' WHERE id=$1", [exhausted]);
    await database.pool.query("UPDATE b00_boss.queue SET monitor_claim_on=NULL WHERE name='poc-crash-exhaust'");
    await boss.supervise('poc-crash-exhaust');
  }
  assert.equal((await boss.findJobs('poc-crash-exhaust', { id: exhausted }))[0].state, 'failed');
  record('pg-boss', 'crash lease', { processKilledAfterClaim: true, reclaimed: true, retryCount: bossReclaimed[0].retryCount, staleCompletionAcceptedWithoutToken: true, touchKeepsLeaseAlive: true, missingHeartbeatExhausts: true, repeatedTimeoutsExhaust: true }, ['Per-attempt fencing at StoreWeave interface']);

  await boss.createQueue('poc-dlq');
  await boss.createQueue('poc-dead', { retryLimit: 0, deadLetter: 'poc-dlq' });
  const bossDead = await boss.send('poc-dead', { version: 1 }); assert(bossDead);
  await boss.fetch('poc-dead'); await boss.fail('poc-dead', bossDead, { message: 'expected failure' });
  const dlq = await boss.findJobs('poc-dlq');
  assert.equal(dlq.length, 1); assert.equal(dlq[0].sourceId, bossDead);
  assert.equal(await boss.redrive('poc-dlq'), 1);
  assert.equal(await boss.redrive('poc-dlq'), 0);
  const redriven = (await boss.fetch('poc-dead', { includeMetadata: true }))[0];
  assert.notEqual(redriven.id, bossDead);
  assert.deepEqual(redriven.data, { version: 1 });
  await boss.complete('poc-dead', redriven.id);
  await boss.createQueue('poc-direct-retry', { retryLimit: 0 });
  const directRetry = await boss.send('poc-direct-retry', { version: 1 }); assert(directRetry);
  await boss.fetch('poc-direct-retry'); await boss.fail('poc-direct-retry', directRetry);
  await boss.retry('poc-direct-retry', directRetry);
  const retried = (await boss.fetch('poc-direct-retry', { includeMetadata: true }))[0];
  assert.equal(retried.id, directRetry); assert.equal(retried.retryCount, 1); assert.equal(retried.retryLimit, 1);
  record('pg-boss', 'DLQ retry', { redrivePreservedId: false, directRetryPreservedId: true, directRetryIncreasesLimit: true, directRetryCount: retried.retryCount, sourceIdPreservedInDLQ: true, repeatedRedriveNoop: true, completed: true }, ['Preserve public job identity and strict dead-only retry/reset semantics in adapter']);

  await boss.createQueue('poc-schedule');
  await boss.schedule('poc-schedule', '0 0 * * *', {}, { tz: 'Asia/Taipei', key: 'taipei' });
  await assert.rejects(boss.schedule('poc-schedule', '* * * * *', {}, { tz: 'Invalid/Zone' }));
  assert.equal((await boss.getSchedules('poc-schedule'))[0].timezone, 'Asia/Taipei');
  // Pinned upstream clock evaluator: no public clock injection exists. This evaluates
  // its actual DST/due-window algorithm, not a replacement scheduler implementation.
  // Reflection is confined to this pinned-version white-box probe; production must
  // not depend on these private members. PgBoss supplies the manager methods used here.
  const timekeeper = Reflect.construct(Timekeeper, [boss.getDb(), boss, { schema: 'b00_boss' }]) as {
    stopped: boolean;
    shouldSendIt(cron: string, timezone: string): boolean;
    cron(): Promise<void>;
    onSendIt(jobs: unknown[]): Promise<void>;
  };
  const realNow = Date.now;
  const due = (cron: string, tz: string, at: string) => {
    Date.now = () => new Date(at).getTime();
    try { return timekeeper.shouldSendIt(cron, tz); } finally { Date.now = realNow; }
  };
  const timezoneObserved = {
    taipeiMidnight: due('0 0 * * *', 'Asia/Taipei', '2026-03-07T16:00:30Z'),
    taipeiFiveMinutesLate: due('0 0 * * *', 'Asia/Taipei', '2026-03-07T16:05:00Z'),
    springGapAtThree: due('30 2 * * *', 'America/New_York', '2026-03-08T07:30:30Z'),
    fallFirst: due('30 1 * * *', 'America/New_York', '2026-11-01T05:30:30Z'),
    fallSecond: due('30 1 * * *', 'America/New_York', '2026-11-01T06:30:30Z'),
  };
  assert.equal(timezoneObserved.taipeiMidnight, true);
  assert.equal(timezoneObserved.taipeiFiveMinutesLate, false);
  assert.equal(timezoneObserved.springGapAtThree, false);
  assert.equal(timezoneObserved.fallFirst, true);
  assert.equal(timezoneObserved.fallSecond, true);
  await boss.createQueue('__pgboss__send-it');
  timekeeper.stopped = false;
  Date.now = () => new Date('2026-03-07T16:00:30Z').getTime();
  try { await timekeeper.cron(); await timekeeper.cron(); } finally { Date.now = realNow; }
  const forwards = await boss.fetch('__pgboss__send-it');
  assert.equal(forwards.length, 1);
  await timekeeper.onSendIt(forwards);
  assert.equal((await boss.fetch('poc-schedule')).length, 1);
  record('pg-boss', 'schedule timezone', { ...timezoneObserved, sameMinuteDoubleCronProducedOneForward: true, forwardedJobClaimed: true }, ['Explicit misfire/pause/overlap contract']);
  assert.deepEqual(errors, []);
} finally {
  const stopped = await Promise.allSettled([previous?.stop(), boss?.stop()]);
  try { await database?.close(); } finally { await container.stop(); }
  assert(stopped.every(result => result.status === 'fulfilled'), 'A PoC queue failed to stop');
}
assert.equal(results.length, 14);
const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));
const dependencies = Object.entries(lock.packages).filter(([path]) => path).map(([path, value]: [string, any]) => ({ path, version: value.version, license: value.license, integrity: value.integrity }));
assert(dependencies.every(item => item.license && item.integrity));
const report = { node: process.version, postgres: serverVersion, image: 'postgres:17-alpine', pgBoss: '12.30.0', previousPgBoss: '12.29.0', dependencies, probes: results };
const output = process.argv[2];
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
