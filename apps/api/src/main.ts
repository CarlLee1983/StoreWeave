import { closeInReverse, installShutdown, withCleanupDeadline } from '@storeweave/kernel';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrapRelease } from '@storeweave/release/bootstrap';
import { serverProjection as selectedServerProjection } from '@storeweave/selected-server';
import { createReleaseServer } from './release-server';
import type { ReleaseHttpAdapter } from './release-adapter';
import { resolveThemeAssetsDir } from './theme-assets';
import { writeStartupHttpCatalog } from './http/catalog-artifact';
import type { HttpRouteCatalogCarrier } from './http/contract';

type ServerProjection = {
  readonly release: Parameters<typeof bootstrapRelease>[0];
  readonly httpAdapter: ReleaseHttpAdapter;
};

function assertServerProjection(value: unknown): asserts value is ServerProjection {
  if (value === null || typeof value !== 'object') {
    throw new Error('Selected API server projection is missing');
  }

  const projection = value as Partial<ServerProjection>;
  const release = projection.release;
  if (!release || typeof release.id !== 'string' || release.id.trim() === '' || typeof release.version !== 'string') {
    throw new Error('Selected API server projection is missing release identity');
  }

  const httpAdapter = projection.httpAdapter;
  if (!httpAdapter || typeof httpAdapter !== 'object') {
    throw new Error(`Server projection "${release.id}" is missing required HTTP adapter contribution`);
  }
  if (httpAdapter.releaseId !== release.id) {
    throw new Error(`Server projection "${release.id}" contains HTTP adapter owned by "${String(httpAdapter.releaseId)}"`);
  }
  if (typeof httpAdapter.controllers !== 'function' || typeof httpAdapter.startSession !== 'function') {
    throw new Error(`Server projection "${release.id}" has an incomplete HTTP adapter contribution`);
  }
}

export async function main(): Promise<void> {
  const projection: unknown = selectedServerProjection;
  assertServerProjection(projection);
  const { release, httpAdapter } = projection;
  const releaseName = release.id;
  const releaseVersion = process.env.STOREWEAVE_RELEASE_VERSION ?? process.env.COMMERCE_RELEASE_VERSION ?? release.version;
  const { runtime, loaded, theme } = await bootstrapRelease(release, { loggerName: `${releaseName}-api` });
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
      release: { version: releaseVersion, configPath: loaded.sourcePath, adminDir, themeAssetsDir },
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
      `${releaseName} api listening`,
    );

    installShutdown(runtime.config.shutdown.timeoutMs, close, logger);
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, close); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API startup and cleanup failed'); }
    throw error;
  }

}

if (require.main === module) main().catch((err) => {
  console.error(`[api] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
