import 'reflect-metadata';
import { bootstrap } from '@storeweave/bundle';
import { Worker } from '@storeweave/kernel';

async function main(): Promise<void> {
  const { runtime } = await bootstrap({ loggerName: 'commerce-worker' });
  const logger = runtime.logger;

  if (!runtime.config.worker.enabled) {
    logger.warn('worker is disabled in commerce.yaml; exiting');
    await runtime.close();
    return;
  }

  const worker = new Worker(runtime);
  worker.start();
  logger.info(
    {
      workerId: worker.id,
      jobTypes: runtime.jobRegistry.types(),
      subscriptions: runtime.events.listSubscriptions().map((s) => `${s.subscriberId}<-${s.eventName}`),
    },
    'commerce worker running',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    await worker.stop();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[commerce-worker] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
