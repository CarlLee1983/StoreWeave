import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@storeweave/bundle';
import { createServer } from './server';

const RELEASE_VERSION = process.env.COMMERCE_RELEASE_VERSION ?? '0.1.0';

async function main(): Promise<void> {
  const { runtime, loaded, theme } = await bootstrap({ loggerName: 'commerce-api' });
  const logger = runtime.logger;

  if (runtime.config.database.autoMigrate) {
    const applied = await runtime.migrate();
    logger.info({ applied: applied.length }, 'migrations applied at startup');
  }

  await runtime.extensions.persistRegistry();

  const adminDir = process.env.COMMERCE_ADMIN_DIR ?? join(__dirname, '..', 'admin');
  const app = await createServer({
    runtime,
    theme,
    release: { version: RELEASE_VERSION, configPath: loaded.sourcePath, adminDir },
  });

  const { host, port } = runtime.config.http;
  await app.listen({ host, port });
  logger.info(
    {
      host, port, store: runtime.config.store.id, theme: theme.id,
      extensions: runtime.extensions.list().map((e) => `${e.id}@${e.version}`),
      mcpTools: runtime.mcpTools.size,
    },
    'commerce api listening',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[commerce-api] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
