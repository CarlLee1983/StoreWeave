import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { closeInReverse, createRuntime, installShutdown, Worker, type PlatformModule } from '@storeweave/kernel';

export const WORKER_RECOVERY_JOB = 'test.worker-recovery.hang';

const release = {
  id: 'worker-recovery',
  version: '1.0.0',
  buildManifestChecksum: `sha256:${'1'.repeat(64)}`,
};

function recoveryModule(mode: 'hang' | 'complete'): PlatformModule {
  return {
    name: 'worker-recovery', version: '1.0.0', baseVersionRange: '^1.0.0',
    jobs: [{
      type: WORKER_RECOVERY_JOB,
      handler: mode === 'hang'
        ? async () => {
          process.stdout.write('claimed\n');
          await new Promise<void>(() => {});
        }
        : async () => {},
    }],
  };
}

/** Both processes assemble identical persisted release metadata; only this test handler's closure varies. */
export function createWorkerRecoveryRuntime(url: string, mode: 'hang' | 'complete') {
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
    }),
    secrets: { get: () => undefined, has: () => false, listNames: () => [] },
    logger: noopLogger,
    modules: [recoveryModule(mode)],
    availableExtensions: {},
  });
}

async function main(): Promise<void> {
  const url = process.env.WORKER_RECOVERY_DATABASE_URL;
  const mode = process.env.WORKER_RECOVERY_MODE;
  if (!url || (mode !== 'hang' && mode !== 'complete')) throw new Error('Missing worker recovery fixture configuration');

  const runtime = await createWorkerRecoveryRuntime(url, mode);
  let worker: Worker | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  const close = () => {
    if (keepAlive) clearInterval(keepAlive);
    process.stdout.write('draining\n');
    return closeInReverse([() => runtime.close(), () => worker?.stop()]);
  };
  try {
    await runtime.activateRelease('require-current');
    worker = new Worker(runtime, { concurrency: 1, pollIntervalMs: 50, staleLockSeconds: 1, workerId: `recovery-${mode}` });
    worker.start();
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
