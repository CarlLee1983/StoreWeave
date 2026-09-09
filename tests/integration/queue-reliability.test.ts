import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database, platformMigrations, runMigrations, sqlMigration } from '@storeweave/db';
import { JobQueue, type EnqueueInput, type JobClaim } from '@storeweave/jobs';
import { createHarness, createTestDatabase, type TestHarness } from './helpers';

let h: TestHarness;

beforeEach(async () => { h = await createHarness(); }, 300_000);
afterEach(async () => { await h?.close(); });

async function enqueue(input: EnqueueInput) {
  return h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, input));
}

async function claim(workerId: string, type: string, leaseSeconds?: number): Promise<JobClaim[]> {
  return h.runtime.database.transaction(tx => h.runtime.jobs.claim(tx, workerId, 1, [type], leaseSeconds));
}

async function job(id: string) {
  const result = await h.runtime.database.db.execute<{
    status: string; occurrence_id: string; claim_token: string | null; payload: unknown; payload_version: number;
    attempts: number; deferred_at: Date | null; cancel_requested_at: Date | null;
  }>(sql`SELECT status, occurrence_id, claim_token, payload, payload_version, attempts, deferred_at, cancel_requested_at
    FROM platform_jobs WHERE id = ${id}`);
  return result.rows[0]!;
}

async function quarantineEvidence(jobId: string) {
  const result = await h.runtime.database.db.execute<{
    job_id: string; occurrence_id: string; payload: unknown; payload_version: number; reason: string;
  }>(sql`SELECT job_id, occurrence_id, payload, payload_version, reason
    FROM platform_job_quarantine WHERE job_id = ${jobId}`);
  return result.rows;
}

describe('queue occurrence fencing', () => {
  it('dedupes four concurrent enqueues to one persisted id', async () => {
    const dedupeKey = `queue-dedupe-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      enqueue({ type: 'platform.event.deliver', payload: { dedupeKey }, dedupeKey }),
    ));

    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.filter(result => !result.deduped)).toHaveLength(1);
    const count = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_jobs WHERE dedupe_key = ${dedupeKey}
    `);
    expect(count.rows[0]?.count).toBe('1');
  });

  it('promotes a deferred replacement only after a fenced completion and rejects late acknowledgements', async () => {
    const type = 'platform.event.deliver';
    const dedupeKey = `queue-replace-${randomUUID()}`;
    const first = await enqueue({ type, payload: { revision: 1 }, dedupeKey });
    const [a] = await claim('same-worker', type);
    expect(a).toBeDefined();

    const replacement = await enqueue({ type, payload: { revision: 2 }, dedupeKey, replaceExisting: true });
    expect(replacement).toEqual({ id: first.id, deduped: true });
    expect(await claim('same-worker', type)).toEqual([]);

    expect(await h.runtime.jobs.complete(h.runtime.database.db, a!)).toMatchObject({ applied: true, status: 'pending' });
    const [b] = await claim('same-worker', type);
    expect(b).toMatchObject({ jobId: first.id });
    expect(b!.occurrenceId).not.toBe(a!.occurrenceId);
    expect(b!.claimToken).not.toBe(a!.claimToken);
    expect(await h.runtime.jobs.complete(h.runtime.database.db, a!)).toEqual({ applied: false });
    expect(await h.runtime.jobs.fail(h.runtime.database.db, a!, 'late failure')).toEqual({ applied: false });
    expect(await job(first.id)).toMatchObject({ status: 'running', occurrence_id: b!.occurrenceId,
      claim_token: b!.claimToken, payload: { revision: 2 }, payload_version: 1 });
    expect(await h.runtime.jobs.heartbeat(h.runtime.database.db, a!)).toEqual({ applied: false });
    expect(await h.runtime.jobs.heartbeat(h.runtime.database.db, b!, 60)).toMatchObject({ applied: true, status: 'running' });
    expect(await h.runtime.jobs.reclaimStale(h.runtime.database.db, 0)).toBe(0);
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs
      SET lease_expires_at = now() - interval '1 second' WHERE id = ${first.id}`);
    expect(await h.runtime.jobs.reclaimStale(h.runtime.database.db, 0)).toBe(1);
    // Lease recovery now uses the same backoff as a fenced failure. It takes a
    // fresh fencing token, but retains the logical occurrence/provider key.
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET run_at = now() WHERE id = ${first.id}`);
    const [c] = await claim('same-worker', type);
    expect(c!.occurrenceId).toBe(b!.occurrenceId);
    expect(c!.claimToken).not.toBe(b!.claimToken);
    expect(await h.runtime.jobs.complete(h.runtime.database.db, b!)).toEqual({ applied: false });
  });

  it('promotes replacement on effective failure and cooperatively cancels a running identity with its deferred work', async () => {
    const type = 'platform.event.deliver';
    const dedupeKey = `queue-fail-${randomUUID()}`;
    const first = await enqueue({ type, payload: { revision: 1 }, dedupeKey });
    const [a] = await claim('worker-a', type);
    await enqueue({ type, payload: { revision: 2 }, dedupeKey, replaceExisting: true });

    expect(await h.runtime.jobs.fail(h.runtime.database.db, a!, 'original failed')).toMatchObject({
      applied: true, status: 'pending', outcome: 'replaced',
    });
    const [b] = await claim('worker-b', type);
    expect(b).toMatchObject({ jobId: first.id, payload: { revision: 2 } });

    const cancellableType = 'platform.event.deliver';
    const cancellableKey = `queue-cancel-${randomUUID()}`;
    const cancellable = await enqueue({ type: cancellableType, payload: { revision: 1 }, dedupeKey: cancellableKey });
    const [running] = await claim('worker-c', cancellableType);
    await enqueue({ type: cancellableType, payload: { revision: 2 }, dedupeKey: cancellableKey, replaceExisting: true });
    expect(await h.runtime.jobs.cancel(h.runtime.database.db, { jobId: running!.jobId, occurrenceId: running!.occurrenceId }))
      .toMatchObject({ applied: true, status: 'running' });
    expect(await job(cancellable.id)).toMatchObject({ status: 'running', deferred_at: null });
    expect((await job(cancellable.id)).cancel_requested_at).not.toBeNull();
    expect(await h.runtime.jobs.complete(h.runtime.database.db, running!)).toMatchObject({ applied: true, status: 'cancelled' });
    expect(await claim('worker-d', cancellableType)).toEqual([]);
  });

  it('claims immediately when the caller clock runs ahead of the database clock', async () => {
    // 呼叫端與 PG 之間的時鐘偏移不可以讓剛入列的工作暫時消失：run_at 的預設值必須由
    // 資料庫決定，明確排程的未來時間才照呼叫端的值。
    const type = 'platform.event.deliver';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const queued = await enqueue({ type, payload: {}, dedupeKey: `queue-clock-skew-${randomUUID()}` });
      const [claimed] = await claim('worker-clock-skew', type);
      expect(claimed).toMatchObject({ jobId: queued.id });

      const scheduled = await enqueue({
        type, payload: {}, dedupeKey: `queue-clock-scheduled-${randomUUID()}`,
        runAt: new Date(Date.now() + 3_600_000),
      });
      expect(await claim('worker-clock-skew', type)).toEqual([]);
      expect((await job(scheduled.id)).status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not requeue a running occurrence behind its fenced handler', async () => {
    const type = 'platform.event.deliver';
    const queued = await enqueue({ type, payload: {}, dedupeKey: `queue-requeue-${randomUUID()}` });
    expect((await claim('worker-requeue', type))[0]).toBeDefined();

    await expect(h.runtime.jobs.requeue(h.runtime.database.db, queued.id)).rejects
      .toMatchObject({ code: 'CONFLICT' });
    expect(await job(queued.id)).toMatchObject({ status: 'running' });
  });

  it('starts a new logical occurrence only for an explicit completed replay, not dead-letter retry', async () => {
    const type = 'platform.event.deliver';
    const queued = await enqueue({ type, payload: {}, dedupeKey: `queue-logical-replay-${randomUUID()}` });
    const [first] = await claim('logical-replay-a', type);
    await h.runtime.jobs.complete(h.runtime.database.db, first!);

    await h.runtime.jobs.requeue(h.runtime.database.db, queued.id);
    const [explicitReplay] = await claim('logical-replay-b', type);
    expect(explicitReplay!.occurrenceId).not.toBe(first!.occurrenceId);
    await h.runtime.jobs.fail(h.runtime.database.db, explicitReplay!, 'dead-letter', true);

    await h.runtime.jobs.retryDead(h.runtime.database.db, queued.id);
    const [deadRetry] = await claim('logical-replay-c', type);
    expect(deadRetry!.occurrenceId).toBe(explicitReplay!.occurrenceId);
    expect(deadRetry!.claimToken).not.toBe(explicitReplay!.claimToken);
  });

  it('preserves an invalid occurrence as evidence then promotes its deferred replacement', async () => {
    const type = 'platform.event.deliver';
    const first = await enqueue({ type, payload: { revision: 1 }, dedupeKey: `queue-quarantine-replace-${randomUUID()}` });
    const [a] = await claim('worker-quarantine-replace', type);
    const key = (await h.runtime.database.db.execute<{ dedupe_key: string }>(sql`SELECT dedupe_key FROM platform_jobs WHERE id = ${first.id}`)).rows[0]!.dedupe_key;
    await enqueue({ type, payload: { revision: 2 }, dedupeKey: key, replaceExisting: true });

    expect(await h.runtime.jobs.quarantine(h.runtime.database.db, a!, 'invalid v1 payload')).toMatchObject({ applied: true, status: 'pending' });
    expect(await quarantineEvidence(first.id)).toEqual([expect.objectContaining({
      job_id: first.id, occurrence_id: a!.occurrenceId, payload: { revision: 1 }, payload_version: 1,
    })]);
    const [b] = await claim('worker-quarantine-replacement', type);
    expect(b).toMatchObject({ jobId: first.id, payload: { revision: 2 } });
    expect(b!.occurrenceId).not.toBe(a!.occurrenceId);
    expect(await h.runtime.jobs.quarantine(h.runtime.database.db, a!, 'stale token')).toEqual({ applied: false });
    expect(await quarantineEvidence(first.id)).toHaveLength(1);
  });

  it('honours cancellation while retaining invalid-occurrence evidence and clearing deferred work', async () => {
    const type = 'platform.event.deliver';
    const key = `queue-quarantine-cancel-${randomUUID()}`;
    const queued = await enqueue({ type, payload: { revision: 1 }, dedupeKey: key });
    const [claimedJob] = await claim('worker-quarantine-cancel', type);
    await enqueue({ type, payload: { revision: 2 }, dedupeKey: key, replaceExisting: true });
    expect(await h.runtime.jobs.cancel(h.runtime.database.db, { jobId: claimedJob!.jobId, occurrenceId: claimedJob!.occurrenceId })).toMatchObject({ applied: true });
    expect(await h.runtime.jobs.quarantine(h.runtime.database.db, claimedJob!, 'invalid while cancelling')).toMatchObject({ applied: true, status: 'cancelled' });
    expect(await job(queued.id)).toMatchObject({ status: 'cancelled', deferred_at: null });
    expect(await quarantineEvidence(queued.id)).toEqual([expect.objectContaining({
      occurrence_id: claimedJob!.occurrenceId, payload: { revision: 1 }, payload_version: 1,
    })]);
  });
});

describe('queue fencing migration', () => {
  it('appends the expand migration and preserves old job identities and history checksums', async () => {
    const database = new Database({ url: await createTestDatabase() });
    // This fixture is the pre-B04 released SQL, not a slice of the source under
    // test. A slice would silently bless an accidental rewrite of history.
    const legacy = { module: 'platform', migrations: [
      sqlMigration('0001_init', 'expand', platformMigrations.migrations[0]!.up),
      sqlMigration('0002_worker_heartbeat', 'expand', `
CREATE TABLE IF NOT EXISTS platform_worker_heartbeat (
  worker_id  text PRIMARY KEY,
  version    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`),
    ] };
    const ids = Array.from({ length: 6 }, () => randomUUID());
    try {
      await runMigrations(database.pool, [legacy]);
      const before = await database.pool.query<{ id: string; checksum: string }>(
        "SELECT id, checksum FROM platform_migrations WHERE id IN ('platform/0001_init', 'platform/0002_worker_heartbeat') ORDER BY id",
      );
      expect(before.rows).toEqual([
        { id: 'platform/0001_init', checksum: expect.any(String) },
        { id: 'platform/0002_worker_heartbeat', checksum: 'sha256:b0a59bb41542ed5cd0e1d3f38959217927e47362b1897ed89bbbb217a6abf507' },
      ]);
      await database.pool.query(`INSERT INTO platform_jobs (id, type, payload, status, attempts, max_attempts)
        VALUES ($1, 'test.legacy', '{"state":"pending"}', 'pending', 1, 5),
               ($2, 'test.legacy', '{"state":"running-unlocked"}', 'running', 2, 5),
               ($3, 'test.legacy', '{"state":"running-locked"}', 'running', 3, 5),
               ($4, 'test.legacy', '{"state":"dead"}', 'dead', 4, 5),
               ($5, 'test.legacy', '{"state":"completed"}', 'completed', 5, 5),
               ($6, 'test.legacy', '{"state":"cancelled"}', 'cancelled', 6, 5)`, ids);
      await database.pool.query("UPDATE platform_jobs SET locked_at = now() - interval '1 hour' WHERE id = $1", [ids[2]]);
      await database.pool.query("UPDATE platform_jobs SET completed_at = '2020-01-02T03:04:05.000Z' WHERE id = $1", [ids[4]]);
      // Pre-B04 cancelled rows have no cancelled_at column; 0006 must use the
      // durable terminal row's existing updated_at instead of leaving it unbounded.
      await database.pool.query("UPDATE platform_jobs SET updated_at = '2020-01-03T04:05:06.000Z' WHERE id = $1", [ids[5]]);

      expect(await runMigrations(database.pool, [platformMigrations])).toEqual([
        'platform/0003_job_occurrence_fencing', 'platform/0004_job_payload_quarantine',
        'platform/0005_outbox_subscriber_snapshot_quarantine', 'platform/0006_job_retention_dedupe_horizon',
        'platform/0007_ops_listing_indexes', 'platform/0008_job_schedules',
      ]);
      const after = await database.pool.query("SELECT id, checksum FROM platform_migrations WHERE id IN ('platform/0001_init', 'platform/0002_worker_heartbeat', 'platform/0003_job_occurrence_fencing', 'platform/0004_job_payload_quarantine', 'platform/0005_outbox_subscriber_snapshot_quarantine', 'platform/0006_job_retention_dedupe_horizon', 'platform/0007_ops_listing_indexes', 'platform/0008_job_schedules') ORDER BY id");
      expect(after.rows.slice(0, 2)).toEqual(before.rows);
      expect(after.rows.slice(2)).toEqual([
        { id: 'platform/0003_job_occurrence_fencing', checksum: expect.any(String) },
        { id: 'platform/0004_job_payload_quarantine', checksum: expect.any(String) },
        { id: 'platform/0005_outbox_subscriber_snapshot_quarantine', checksum: expect.any(String) },
        { id: 'platform/0006_job_retention_dedupe_horizon', checksum: expect.any(String) },
        { id: 'platform/0007_ops_listing_indexes', checksum: expect.any(String) },
        { id: 'platform/0008_job_schedules', checksum: expect.any(String) },
      ]);
      const rows = await database.pool.query<{ id: string; payload: { state: string }; status: string; attempts: number; payload_version: number; occurrence_id: string }>(
        'SELECT id, payload, status, attempts, payload_version, occurrence_id FROM platform_jobs ORDER BY attempts',
      );
      expect(rows.rows).toEqual(['pending', 'running-unlocked', 'running-locked', 'dead', 'completed', 'cancelled'].map((state, index) => ({
        id: ids[index], payload: { state }, status: state.startsWith('running') ? 'running' : state, attempts: index + 1,
        payload_version: 1, occurrence_id: expect.any(String),
      })));
      const retention = await database.pool.query<{ id: string; status: string; retain_seconds: string; dedupe_seconds: string }>(`
        SELECT id, status,
          EXTRACT(EPOCH FROM (retain_until - CASE WHEN status = 'completed' THEN completed_at ELSE updated_at END))::text AS retain_seconds,
          EXTRACT(EPOCH FROM (dedupe_until - CASE WHEN status = 'completed' THEN completed_at ELSE updated_at END))::text AS dedupe_seconds
        FROM platform_jobs WHERE id = ANY($1::uuid[]) ORDER BY attempts
      `, [[ids[4], ids[5]]]);
      expect(retention.rows).toEqual([
        { id: ids[4], status: 'completed', retain_seconds: '604800.000000', dedupe_seconds: '2592000.000000' },
        { id: ids[5], status: 'cancelled', retain_seconds: '604800.000000', dedupe_seconds: '2592000.000000' },
      ]);
      expect(await new JobQueue().reclaimStale(database.db, 0)).toBe(2);
    } finally {
      await database.close();
    }
  });
});
