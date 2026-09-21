import 'reflect-metadata';
import { basename } from 'node:path';
import { bootstrapRelease } from '@storeweave/release/bootstrap';
import { workerProjection as selectedWorkerProjection } from '@storeweave/selected-worker';
import { Worker, closeInReverse, installShutdown, withCleanupDeadline } from '@storeweave/kernel';
import { installFatalBoundary, onceAsync } from './fatal-boundary';

type WorkerProjection = {
  readonly target: 'worker';
  readonly release: Parameters<typeof bootstrapRelease>[0];
};

function assertWorkerProjection(value: unknown): asserts value is WorkerProjection {
  if (value === null || typeof value !== 'object') {
    throw new Error('Selected worker projection is missing');
  }

  const projection = value as Partial<WorkerProjection>;
  if (projection.target !== 'worker') {
    throw new Error(`Selected worker projection has target "${String(projection.target)}"; expected "worker"`);
  }
  const release = projection.release;
  if (!release || typeof release.id !== 'string' || release.id.trim() === '' || typeof release.version !== 'string') {
    throw new Error('Selected worker projection is missing release identity');
  }
}

export async function main(): Promise<void> {
  const projection: unknown = selectedWorkerProjection;
  assertWorkerProjection(projection);
  const { release } = projection;
  const releaseName = release.id;
  const { runtime, loaded } = await bootstrapRelease(release, { loggerName: `${releaseName}-worker` });
  const logger = runtime.logger;

  if (!runtime.config.worker.enabled) {
    logger.warn(`worker is disabled in ${basename(loaded.sourcePath)}; exiting`);
    await runtime.close();
    return;
  }

  let worker: Worker | undefined;
  const close = onceAsync(() => closeInReverse([() => runtime.close(), () => worker?.stop()]));
  try {
    await runtime.activateRelease('require-current');
    worker = new Worker(runtime);
    worker.assertReady();
    worker.start();
    // Worker is a library and never exits the process itself. A fatal lease
    // heartbeat/timeout completion is instead handed to this entrypoint.
    installFatalBoundary({
      fatal: worker.waitForFatal(),
      timeoutMs: runtime.config.shutdown.timeoutMs,
      close,
      logger,
      workerId: worker.id,
    });
    logger.info(
      {
        workerId: worker.id,
        jobTypes: runtime.jobRegistry.types(),
        subscriptions: runtime.events.listSubscriptions().map((s) => `${s.subscriberId}<-${s.eventName}`),
      },
      `${releaseName} worker running`,
    );

    installShutdown(runtime.config.shutdown.timeoutMs, close, logger);
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, close); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Worker startup and cleanup failed'); }
    throw error;
  }

}

if (require.main === module) main().catch((err) => {
  console.error(`[worker] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
