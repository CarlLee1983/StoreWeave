import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';
import { createWorkerRecoveryRuntime, WORKER_RECOVERY_JOB } from './fixtures/worker-recovery';

const FIXTURE = resolve('tests/integration/fixtures/worker-recovery.ts');
const CHILD_TIMEOUT_MS = 8_000;

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

function startWorker(url: string, mode: 'hang' | 'complete'): StartedChild {
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

describe('worker recovery', () => {
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

      await new Promise(resolve => setTimeout(resolve, 1_100));
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
  }, 40_000);
});
