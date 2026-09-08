import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';
import { createWorkerRecoveryRuntime, WORKER_RECOVERY_EVENT, WORKER_RECOVERY_JOB } from './fixtures/worker-recovery';

const FIXTURE = resolve('tests/integration/fixtures/worker-recovery.ts');
// 子程序要走完 lease 過期、reclaim backoff 與重跑；8 秒在機器有負載（例如同時跑 release smoke）
// 時會壓線，讓 gate 變成擲骰子。放寬只影響等待上限，不放寬任何斷言。
const CHILD_TIMEOUT_MS = 20_000;

interface ExitResult { code: number | null; signal: NodeJS.Signals | null; }
interface StartedChild {
  child: ChildProcess;
  output: () => string;
  error: () => Error | undefined;
  exited: Promise<ExitResult>;
}

const children: StartedChild[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, exited }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withDeadline(exited, 'child cleanup');
  }));
});

function startWorker(url: string, mode: 'hang' | 'complete' | 'uncooperative' | 'heartbeat' | 'side-effect' | 'provider-complete' | 'event-side-effect' | 'event-provider-complete'): StartedChild {
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      env: { ...process.env, WORKER_RECOVERY_CHILD: '1', WORKER_RECOVERY_DATABASE_URL: url, WORKER_RECOVERY_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error('Could not spawn worker fixture', { cause: error });
  }
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill('SIGKILL');
    throw new Error('Worker fixture did not expose output pipes');
  }
  let output = '';
  let spawnError: Error | undefined;
  stdout.on('data', data => { output += data; });
  stderr.on('data', data => { output += data; });
  let resolveExit!: (result: ExitResult) => void;
  const exited = new Promise<ExitResult>(resolve => { resolveExit = resolve; });
  child.once('error', error => { spawnError = error; resolveExit({ code: null, signal: null }); });
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
  const started = {
    child,
    output: () => output,
    error: () => spawnError,
    exited,
  };
  children.push(started);
  return started;
}

async function withDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), CHILD_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForOutput(process: StartedChild, text: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!process.output().includes(text)) {
    if (process.error()) throw new Error(`Worker failed to spawn: ${process.error()!.message}`);
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`Worker exited before ${text}: ${process.output()}`);
    }
    if (Date.now() >= deadline) throw new Error(`Worker did not emit ${text}: ${process.output()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForJob(client: Client, id: string, predicate: (job: { status: string; attempts: number; completed_at: Date | null }) => boolean) {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = (await client.query<{ status: string; attempts: number; completed_at: Date | null }>(
      'SELECT status, attempts, completed_at FROM platform_jobs WHERE id = $1', [id],
    )).rows[0];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${id} did not reach the expected persisted state`);
}

function effectKey(output: string): string {
  const key = /^effect:([0-9a-f-]{36})$/m.exec(output)?.[1];
  if (!key) throw new Error(`Worker did not emit a provider effect key: ${output}`);
  return key;
}

function eventEffectKey(output: string): string {
  const key = /^event-effect:(evt:[0-9a-f-]{36}:worker-recovery)$/m.exec(output)?.[1];
  if (!key) throw new Error(`Worker did not emit an event provider effect key: ${output}`);
  return key;
}

async function prepareProviderLedger(client: Client): Promise<void> {
  await client.query(`CREATE TABLE test_worker_recovery_provider_effects (
    idempotency_key text PRIMARY KEY,
    provider_calls integer NOT NULL
  )`);
}

async function expireLease(client: Client, jobId: string): Promise<void> {
  const result = await client.query(`UPDATE platform_jobs
    SET lease_expires_at = now() - interval '1 second'
    WHERE id = $1 AND status = 'running'`, [jobId]);
  if (result.rowCount !== 1) throw new Error(`Could not expire running lease for ${jobId}`);
}

async function providerEffects(client: Client) {
  return (await client.query<{ idempotency_key: string; provider_calls: number }>(
    'SELECT idempotency_key, provider_calls FROM test_worker_recovery_provider_effects ORDER BY idempotency_key',
  )).rows;
}

describe('worker recovery', () => {
  it('keeps evt:eventId:subscriberId through a SIGKILL after the durable provider effect commits', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    const eventId = randomUUID();
    const key = `evt:${eventId}:worker-recovery`;
    try {
      await setup.migrate();
      await client.connect();
      await prepareProviderLedger(client);
      await client.query(`INSERT INTO platform_outbox
        (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids)
        VALUES ($1, $2, 1, '{}'::jsonb, 'test', 'test', '["worker-recovery"]'::jsonb)`, [eventId, WORKER_RECOVERY_EVENT.name]);
      await setup.close();

      const crashed = startWorker(url, 'event-side-effect');
      await waitForOutput(crashed, 'event-effect:');
      expect(eventEffectKey(crashed.output())).toBe(key);
      const job = (await client.query<{ id: string }>('SELECT id FROM platform_jobs WHERE dedupe_key = $1', [key])).rows[0];
      if (!job) throw new Error('Outbox delivery job was not created');
      await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1);
      crashed.child.kill('SIGKILL');
      expect(await withDeadline(crashed.exited, 'event-provider crash')).toEqual({ code: null, signal: 'SIGKILL' });
      await expireLease(client, job.id);

      const recovery = startWorker(url, 'event-provider-complete');
      await waitForOutput(recovery, 'event-effect:');
      expect(eventEffectKey(recovery.output())).toBe(key);
      expect(await waitForJob(client, job.id, row => row.status === 'completed' && row.attempts === 2))
        .toMatchObject({ status: 'completed', attempts: 2 });
      expect(await providerEffects(client)).toEqual([{ idempotency_key: key, provider_calls: 2 }]);
      recovery.child.kill('SIGTERM');
      expect(await withDeadline(recovery.exited, 'event provider recovery worker exit')).toEqual({ code: 0, signal: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 40_000);

  it('reuses one logical occurrence key after a committed provider effect, then completes on recovery', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, { type: WORKER_RECOVERY_JOB, payload: {}, maxAttempts: 2 }));
      await setup.close();
      await client.connect();
      await prepareProviderLedger(client);
      const crashed = startWorker(url, 'side-effect');
      await waitForOutput(crashed, 'effect:');
      const firstKey = effectKey(crashed.output());
      const firstState = await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null);
      expect((await client.query<{ occurrence_id: string; claim_token: string }>('SELECT occurrence_id, claim_token FROM platform_jobs WHERE id = $1', [job.id])).rows[0])
        .toMatchObject({ occurrence_id: firstKey, claim_token: expect.any(String) });
      crashed.child.kill('SIGKILL');
      expect(await withDeadline(crashed.exited, 'provider-effect crash')).toEqual({ code: null, signal: 'SIGKILL' });
      expect(firstState).toMatchObject({ status: 'running', attempts: 1 });
      await expireLease(client, job.id);

      const recovery = startWorker(url, 'provider-complete');
      await waitForOutput(recovery, 'ready');
      await waitForOutput(recovery, 'effect:');
      expect(effectKey(recovery.output())).toBe(firstKey);
      expect(await waitForJob(client, job.id, row => row.status === 'completed' && row.attempts === 2 && row.completed_at !== null))
        .toMatchObject({ status: 'completed', attempts: 2 });
      expect(await providerEffects(client)).toEqual([{ idempotency_key: firstKey, provider_calls: 2 }]);
      recovery.child.kill('SIGTERM');
      expect(await withDeadline(recovery.exited, 'provider recovery worker exit')).toEqual({ code: 0, signal: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 40_000);

  it('consumes crash-only attempts with one provider effect identity, then reaches dead at maxAttempts', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, { type: WORKER_RECOVERY_JOB, payload: {}, maxAttempts: 2 }));
      await setup.close();
      await client.connect();
      await prepareProviderLedger(client);
      let providerKey: string | undefined;
      for (const attempt of [1, 2]) {
        const crashed = startWorker(url, 'side-effect');
        await waitForOutput(crashed, 'effect:');
        const currentKey = effectKey(crashed.output());
        if (providerKey) expect(currentKey).toBe(providerKey);
        else providerKey = currentKey;
        expect(await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === attempt && row.completed_at === null))
          .toMatchObject({ status: 'running', attempts: attempt });
        crashed.child.kill('SIGKILL');
        expect(await withDeadline(crashed.exited, `crash-only attempt ${attempt}`)).toEqual({ code: null, signal: 'SIGKILL' });
        await expireLease(client, job.id);
      }

      const recovery = startWorker(url, 'complete');
      await waitForOutput(recovery, 'ready');
      expect(await waitForJob(client, job.id, row => row.status === 'dead' && row.attempts === 2 && row.completed_at === null))
        .toMatchObject({ status: 'dead', attempts: 2, completed_at: null });
      expect(await providerEffects(client)).toEqual([{ idempotency_key: providerKey!, provider_calls: 2 }]);
      recovery.child.kill('SIGTERM');
      expect(await withDeadline(recovery.exited, 'crash-exhaustion recovery worker exit')).toEqual({ code: 0, signal: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 40_000);

  it('gives a deferred replacement a new logical occurrence and provider key', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, {
        type: WORKER_RECOVERY_JOB, payload: {}, dedupeKey: 'worker-recovery-replacement', maxAttempts: 2,
      }));
      await client.connect();
      await prepareProviderLedger(client);
      const original = startWorker(url, 'side-effect');
      await waitForOutput(original, 'effect:');
      const originalKey = effectKey(original.output());
      await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null);
      await setup.database.transaction(tx => setup.jobs.enqueue(tx, {
        type: WORKER_RECOVERY_JOB, payload: {}, dedupeKey: 'worker-recovery-replacement', replaceExisting: true, maxAttempts: 2,
      }));
      expect((await client.query<{ occurrence_id: string; deferred_at: Date | null }>(
        'SELECT occurrence_id, deferred_at FROM platform_jobs WHERE id = $1', [job.id],
      )).rows[0]).toMatchObject({ occurrence_id: originalKey, deferred_at: expect.any(Date) });
      original.child.kill('SIGKILL');
      expect(await withDeadline(original.exited, 'replacement original crash')).toEqual({ code: null, signal: 'SIGKILL' });
      await expireLease(client, job.id);

      const replacement = startWorker(url, 'provider-complete');
      await waitForOutput(replacement, 'effect:');
      const replacementKey = effectKey(replacement.output());
      expect(replacementKey).not.toBe(originalKey);
      expect(await waitForJob(client, job.id, row => row.status === 'completed' && row.attempts === 1 && row.completed_at !== null))
        .toMatchObject({ status: 'completed', attempts: 1 });
      expect(await providerEffects(client)).toEqual([
        { idempotency_key: [originalKey, replacementKey].sort()[0], provider_calls: 1 },
        { idempotency_key: [originalKey, replacementKey].sort()[1], provider_calls: 1 },
      ]);
      replacement.child.kill('SIGTERM');
      expect(await withDeadline(replacement.exited, 'replacement worker exit')).toEqual({ code: 0, signal: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 40_000);

  it('process-fails a noncooperative timed-out handler without acknowledging its lease', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, { type: WORKER_RECOVERY_JOB, payload: {}, maxAttempts: 2 }));
      await setup.close();
      await client.connect();
      const child = startWorker(url, 'uncooperative');
      await waitForOutput(child, 'claimed');
      await waitForOutput(child, 'fatal:');
      expect(await withDeadline(child.exited, 'timed-out worker exit')).toEqual({ code: 1, signal: null });
      expect(await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null))
        .toMatchObject({ status: 'running', attempts: 1, completed_at: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 20_000);

  it('process-fails when a fenced heartbeat is blocked and leaves the lease for recovery', async () => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, { type: WORKER_RECOVERY_JOB, payload: {}, maxAttempts: 2 }));
      await setup.close();
      await client.connect();
      const child = startWorker(url, 'heartbeat');
      await waitForOutput(child, 'claimed');
      await client.query('BEGIN');
      await client.query('LOCK TABLE platform_jobs IN ACCESS EXCLUSIVE MODE');
      await waitForOutput(child, 'fatal:Heartbeat database operation');
      expect(await withDeadline(child.exited, 'blocked-heartbeat worker exit')).toEqual({ code: 1, signal: null });
      await client.query('ROLLBACK');
      expect(await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null))
        .toMatchObject({ status: 'running', attempts: 1, completed_at: null });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 20_000);

  it.each([
    ['SIGTERM drains until its shutdown deadline', 'SIGTERM', { code: 1, signal: null }],
    ['SIGKILL leaves the same reclaimable lease', 'SIGKILL', { code: null, signal: 'SIGKILL' }],
  ] as const)('%s', async (_name, signal, expectedExit) => {
    const url = await createTestDatabase();
    const setup = await createWorkerRecoveryRuntime(url, 'complete');
    const client = new Client({ connectionString: url });
    try {
      await setup.migrate();
      const job = await setup.database.transaction(tx => setup.jobs.enqueue(tx, { type: WORKER_RECOVERY_JOB, payload: {}, maxAttempts: 2 }));
      await setup.close();

      await client.connect();
      const hung = startWorker(url, 'hang');
      await waitForOutput(hung, 'ready');
      await waitForOutput(hung, 'claimed');
      expect(await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null))
        .toMatchObject({ status: 'running', attempts: 1, completed_at: null });

      hung.child.kill(signal);
      if (signal === 'SIGTERM') await waitForOutput(hung, 'draining');
      expect(await withDeadline(hung.exited, 'hung worker exit')).toEqual(expectedExit);
      expect(await waitForJob(client, job.id, row => row.status === 'running' && row.attempts === 1 && row.completed_at === null))
        .toMatchObject({ status: 'running', attempts: 1, completed_at: null });

      await new Promise(resolve => setTimeout(resolve, 2_100));
      const restarted = startWorker(url, 'complete');
      await waitForOutput(restarted, 'ready');
      expect(await waitForJob(client, job.id, row => row.status === 'completed' && row.attempts === 2 && row.completed_at !== null))
        .toMatchObject({ status: 'completed', attempts: 2 });
      restarted.child.kill('SIGTERM');
      expect(await withDeadline(restarted.exited, 'restarted worker exit')).toEqual({ code: 0, signal: null });
    } finally {
      await client.end().catch(() => undefined);
      await setup.close().catch(() => undefined);
    }
  }, 60_000);
});
