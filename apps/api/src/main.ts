import { closeInReverse, installShutdown, withCleanupDeadline } from '@storeweave/kernel';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrapRelease } from '@storeweave/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { createReleaseServer } from './release-server';
import { httpAdapter } from '@storeweave/selected-http';
import { resolveThemeAssetsDir } from './theme-assets';
import { writeStartupHttpCatalog } from './http/catalog-artifact';
import type { HttpRouteCatalogCarrier } from './http/contract';

const RELEASE_VERSION = process.env.STOREWEAVE_RELEASE_VERSION ?? process.env.COMMERCE_RELEASE_VERSION ?? release.version;

const RELEASE_NAME = release.id === 'commerce' ? 'commerce' : 'storeweave';

export async function main(): Promise<void> {
  if (httpAdapter.releaseId !== release.id) throw new Error('HTTP adapter does not match the selected release');
  const { runtime, loaded, theme } = await bootstrapRelease(release, { loggerName: `${RELEASE_NAME}-api` });
  const logger = runtime.logger;

  let app: NestFastifyApplication | undefined;
  const close = () => closeInReverse([() => runtime.close(), () => app?.close()]);
  try {
    if (runtime.config.database.autoMigrate) {
      const applied = await runtime.migrate();
      logger.info({ applied: applied.length }, 'migrations applied at startup');
    } else {
      await runtime.activateRelease('require-current');
    }

    const adminDir = process.env.COMMERCE_ADMIN_DIR ?? join(__dirname, '..', 'admin');
    // This is resolved at each API start so tsx watch also picks up new artwork.
    const themeAssetsDir = theme ? resolveThemeAssetsDir() : undefined;
    app = await createReleaseServer({
      httpAdapter,
      runtime,
      theme,
      release: { version: RELEASE_VERSION, configPath: loaded.sourcePath, adminDir, themeAssetsDir },
    });
    const catalogOutput = process.env.STOREWEAVE_HTTP_CATALOG_OUTPUT;
    if (catalogOutput) writeStartupHttpCatalog({ output: catalogOutput, runtime,
      carrier: app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier });

    const { host, port } = runtime.config.http;
    await app.listen({ host, port });
    logger.info(
      {
        host, port, store: runtime.config.store.id, theme: theme?.id,
        extensions: runtime.extensions.list().map((e) => `${e.id}@${e.version}`),
        mcpTools: runtime.mcpTools.size,
      },
      `${RELEASE_NAME} api listening`,
    );

    installShutdown(runtime.config.shutdown.timeoutMs, close, logger);
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, close); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API startup and cleanup failed'); }
    throw error;
  }

}

if (require.main === module) main().catch((err) => {
  console.error(`[${RELEASE_NAME}-api] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
