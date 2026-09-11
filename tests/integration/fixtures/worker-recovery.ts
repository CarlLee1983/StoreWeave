import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { defineEvent, noopLogger } from '@storeweave/contracts';
import { Client } from 'pg';
import { z } from 'zod';
import { closeInReverse, createRuntime, installShutdown, Worker, type PlatformModule } from '@storeweave/kernel';

export const WORKER_RECOVERY_JOB = 'test.worker-recovery.hang';
export const WORKER_RECOVERY_EVENT = defineEvent({ name: 'test.worker.recoveryEmitted.v1', payload: z.object({}).strict() });

const release = {
  id: 'worker-recovery',
  version: '1.0.0',
  buildManifestChecksum: `sha256:${'1'.repeat(64)}`,
};

type RecoveryMode = 'hang' | 'complete' | 'uncooperative' | 'heartbeat' | 'side-effect' | 'provider-complete' | 'event-side-effect' | 'event-provider-complete';

const PROVIDER_EFFECT_TABLE = 'test_worker_recovery_provider_effects';

async function recordProviderEffect(url: string, idempotencyKey: string): Promise<void> {
  // This client deliberately does not share the worker transaction: it models
  // a provider accepting and committing the effect before the worker can ack.
  const provider = new Client({ connectionString: url });
  await provider.connect();
  try {
    await provider.query(`INSERT INTO ${PROVIDER_EFFECT_TABLE} (idempotency_key, provider_calls)
      VALUES ($1, 1)
      ON CONFLICT (idempotency_key) DO UPDATE SET provider_calls = ${PROVIDER_EFFECT_TABLE}.provider_calls + 1`, [idempotencyKey]);
  } finally {
    await provider.end();
  }
}

function recoveryModule(url: string, mode: RecoveryMode): PlatformModule {
  return {
    name: 'worker-recovery', version: '1.0.0', baseVersionRange: '^1.0.0',
    events: [WORKER_RECOVERY_EVENT],
    // Keep the persisted release shape identical across fixture modes; only handler behavior varies.
    subscribers: [{
      eventName: WORKER_RECOVERY_EVENT.name,
      handler: async (_event, ctx) => {
        if (mode !== 'event-side-effect' && mode !== 'event-provider-complete') return;
        if (!ctx.idempotencyKey?.startsWith('evt:')) throw new Error('Event delivery requires its stable event/subscriber provider key');
        await recordProviderEffect(url, ctx.idempotencyKey);
        process.stdout.write(`event-effect:${ctx.idempotencyKey}\n`);
        if (mode === 'event-provider-complete') return;
        await new Promise<void>(() => {});
      },
    }],
    jobs: [{
      type: WORKER_RECOVERY_JOB,
      jobContractV1: {
        currentVersion: 1, versions: { 1: z.object({}).strict() },
        ...(mode === 'uncooperative' ? { execution: { timeoutMs: 100 } } : {}),
      },
      handler: mode === 'complete'
        ? async () => {}
        : async (_payload, ctx) => {
          process.stdout.write('claimed\n');
          if (mode === 'side-effect' || mode === 'provider-complete') {
            if (ctx.idempotencyKey !== ctx.occurrenceId) throw new Error('Job context provider key must equal its logical occurrence');
            await recordProviderEffect(url, ctx.idempotencyKey);
            process.stdout.write(`effect:${ctx.idempotencyKey}\n`);
          }
          if (mode === 'provider-complete') return;
          await new Promise<void>(() => {});
        },
    }],
  };
}

/** Both processes assemble identical persisted release metadata; only this test handler's closure varies. */
export function createWorkerRecoveryRuntime(url: string, mode: RecoveryMode) {
  return createRuntime({
    release,
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1,
      store: { id: 'worker-recovery', name: 'Worker recovery' },
      database: { url },
      worker: { concurrency: 1, pollIntervalMs: 50 },
      shutdown: { timeoutMs: 250 },
      logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: {
      get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? Buffer.alloc(32, 3).toString('base64url') : undefined,
      has: (name: string) => name === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'],
    },
    logger: noopLogger,
    modules: [recoveryModule(url, mode)],
    availableExtensions: {},
  });
}

async function main(): Promise<void> {
  const url = process.env.WORKER_RECOVERY_DATABASE_URL;
  const mode = process.env.WORKER_RECOVERY_MODE;
  if (!url || !(['hang', 'complete', 'uncooperative', 'heartbeat', 'side-effect', 'provider-complete', 'event-side-effect', 'event-provider-complete'] as const).includes(mode as RecoveryMode)) throw new Error('Missing worker recovery fixture configuration');

  const runtime = await createWorkerRecoveryRuntime(url, mode as RecoveryMode);
  let worker: Worker | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  const close = () => {
    if (keepAlive) clearInterval(keepAlive);
    process.stdout.write('draining\n');
    return closeInReverse([() => runtime.close(), () => worker?.stop()]);
  };
  try {
    await runtime.activateRelease('require-current');
    worker = new Worker(runtime, {
      concurrency: 1, pollIntervalMs: 50, staleLockSeconds: 2, workerId: `recovery-${mode}`,
      // The recovery scenarios deliberately spawn a second PostgreSQL client
      // for the simulated provider effect.  Keep the fixture fail-stop timing
      // well within its two-second lease without making ordinary Docker I/O a
      // synthetic fatal error; the heartbeat-specific case remains tight below.
      ...(mode !== 'heartbeat' ? { heartbeatIntervalMs: 700, databaseTimeoutMs: 500, abortGraceMs: 700 } : {}),
      // This scenario subsequently blocks the heartbeat transaction with an
      // exclusive table lock.  Give startup normal Docker scheduling room,
      // while retaining a bounded heartbeat failure well inside the lease.
      ...(mode === 'heartbeat' ? { heartbeatIntervalMs: 400, databaseTimeoutMs: 200, abortGraceMs: 400 } : {}),
    });
    worker.start();
    void worker.waitForFatal().then(async (fatal) => {
      process.stdout.write(`fatal:${fatal.message}\n`);
      try { await close(); } catch { /* fail-stop entrypoint exits below */ }
      process.exit(1);
    });
    installShutdown(250, close, noopLogger);
    keepAlive = setInterval(() => {}, 1_000); // Keeps the fixture alive while its deliberately hung handler has no active I/O.
    process.stdout.write('ready\n');
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.env.WORKER_RECOVERY_CHILD === '1') {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
