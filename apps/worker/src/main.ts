import 'reflect-metadata';
import { bootstrapRelease } from '@storeweave/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { Worker, closeInReverse, installShutdown, withCleanupDeadline } from '@storeweave/kernel';
import { installFatalBoundary, onceAsync } from './fatal-boundary';

const RELEASE_NAME = release.id === 'commerce' ? 'commerce' : 'storeweave';

async function main(): Promise<void> {
  const { runtime } = await bootstrapRelease(release, { loggerName: `${RELEASE_NAME}-worker` });
  const logger = runtime.logger;

  if (!runtime.config.worker.enabled) {
    logger.warn(`worker is disabled in ${RELEASE_NAME}.yaml; exiting`);
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
      `${RELEASE_NAME} worker running`,
    );

    installShutdown(runtime.config.shutdown.timeoutMs, close, logger);
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, close); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Worker startup and cleanup failed'); }
    throw error;
  }

}

main().catch((err) => {
  console.error(`[${RELEASE_NAME}-worker] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
