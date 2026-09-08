import { loadReleaseConfig, type BaseConfig, type LoadedConfig } from '@storeweave/config';
import { closeInReverse, withCleanupDeadline, createLogger, createRuntime, type Runtime, type StorefrontTheme } from '@storeweave/kernel';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { PlatformError } from '@storeweave/contracts';
import type { ReleaseDefinition } from './release';
import { assertReleaseComposition } from './release-manifest';
import { catalogDigest } from '@storeweave/db';

export interface BootstrapOptions {
  configPath?: string;
  loggerName: string;
  /** CLI uses stderr so stdout remains machine-readable. File logging retains its destination. */
  logDestination?: 'stdout' | 'stderr';
}

export interface ReleaseBootstrapResult<C extends BaseConfig> {
  release: ReleaseDefinition<C>;
  runtime: Runtime<C>;
  loaded: LoadedConfig<C>;
  theme?: StorefrontTheme;
}

export async function bootstrapRelease<C extends BaseConfig>(
  release: ReleaseDefinition<C>, options: BootstrapOptions,
): Promise<ReleaseBootstrapResult<C>> {
  const loaded = loadReleaseConfig(release.config, options.configPath);
  const { config, secrets } = loaded;
  const logger = createLogger({
    level: config.logging.level,
    destination: config.logging.destination === 'stdout'
      ? options.logDestination ?? 'stdout' : config.logging.destination,
    file: config.logging.file, name: options.loggerName,
  });
  try {
    const theme = Object.hasOwn(release.availableThemes, config.theme.id)
      ? release.availableThemes[config.theme.id] : undefined;
    if (!theme && config.theme.id !== 'none') {
      throw PlatformError.validation(`Theme "${config.theme.id}" is not part of release "${release.id}"`);
    }
    if (theme) {
      const parsed = theme.optionsSchema.safeParse(config.theme.options);
      if (!parsed.success) throw PlatformError.validation(`Invalid theme options for "${theme.id}"`, parsed.error.issues);
      config.theme.options = parsed.data as Record<string, unknown>;
    }
    const providers = new ProviderRegistry(logger);
    const modules = release.createModules({ config, providers });
    const manifest = assertReleaseComposition(release, modules);
    const expectedChecksum = process.env.STOREWEAVE_BUILD_MANIFEST_SHA;
    if (expectedChecksum && catalogDigest(manifest) !== expectedChecksum) {
      throw new Error('Release manifest does not match the built artifact');
    }
    const runtime = await createRuntime({
      config, secrets, logger, providers, roles: release.roles,
      modules, release: { id: release.id, version: release.version, buildManifestChecksum: catalogDigest(manifest) },
      availableExtensions: release.availableExtensions, platformVersion: release.baseVersion,
    });
    const closeRuntime = runtime.close;
    let closing: Promise<void> | undefined;
    runtime.close = () => closing ??= withCleanupDeadline(config.shutdown.timeoutMs,
      () => closeInReverse([() => logger.close(), closeRuntime]));
    return { release, runtime, loaded, theme };
  } catch (error) {
    try { await withCleanupDeadline(config.shutdown.timeoutMs, () => logger.close()); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Bootstrap and logger cleanup failed'); }
    throw error;
  }

}
