import { catalogDigest, validateWorkOwnership } from '@storeweave/db';
import { noopLogger } from '@storeweave/contracts';
import type { BaseConfig } from '@storeweave/config';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { JobQueue } from '@storeweave/jobs';
import { EventBus } from '@storeweave/event-bus';
import { OutboxStore } from '@storeweave/outbox';
import { composeRuntimeModules, projectModulePins, projectExtensionPin, type PlatformModule } from '@storeweave/kernel';
import type { ReleaseDefinition, ReleaseBuildManifest, BuildModuleManifest, BuildExtensionManifest } from './release';

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function projectModules(modules: readonly PlatformModule[]): BuildModuleManifest[] {
  return projectModulePins(modules).map(pin => {
    const module = modules.find(module => module.name === pin.id)!;
    return { ...pin, baseVersionRange: module.baseVersionRange,
      requiredDependencies: [...module.dependencies?.required ?? []].sort((a, b) => compare(a.name, b.name)),
      optionalDependencies: [...module.dependencies?.optional ?? []].sort((a, b) => compare(a.name, b.name)),
    };
  });
}

export function projectReleaseManifest<C extends BaseConfig>(
  release: ReleaseDefinition<C>, releaseModules: readonly PlatformModule[],
): ReleaseBuildManifest {
  const modules = projectModules(composeRuntimeModules({
    modules: releaseModules, roles: release.roles, platformVersion: release.baseVersion,
    jobs: new JobQueue(), events: new EventBus(), outbox: new OutboxStore(), logger: noopLogger,
    // manifest 投影只讀模組的宣告，不會執行任何 handler，所以這條路上沒有排程器。
    scheduler: () => { throw new Error('Release manifest projection has no scheduler'); },
  }));
  const availableExtensions = Object.entries(release.availableExtensions).map(([id, definition]): BuildExtensionManifest => {
    if (id !== definition.manifest.id) throw new Error(`Extension catalog key does not match manifest id: ${id}`);
    return { ...projectExtensionPin(definition, release.baseVersion), platformVersion: definition.manifest.platformVersion };
  }).sort((a, b) => compare(a.id, b.id));
  validateWorkOwnership([...modules, ...availableExtensions]);
  return { schemaVersion: 1, releaseId: release.id, releaseVersion: release.version, baseVersion: release.baseVersion,
    rolesChecksum: catalogDigest(release.roles), modules, availableExtensions };
}

/** Reads no store files/secrets and never calls extension setup or module handlers. */
export function buildReleaseManifest<C extends BaseConfig>(release: ReleaseDefinition<C>): ReleaseBuildManifest {
  const config = release.config.schema.parse(release.manifestConfig);
  return projectReleaseManifest(release, release.createModules({ config, providers: new ProviderRegistry(noopLogger) }));
}

export function assertReleaseComposition<C extends BaseConfig>(
  release: ReleaseDefinition<C>, modules: readonly PlatformModule[],
): ReleaseBuildManifest {
  const expected = buildReleaseManifest(release);
  if (catalogDigest(projectReleaseManifest(release, modules)) !== catalogDigest(expected)) {
    throw new Error(`Release "${release.id}" module metadata varies with runtime configuration`);
  }
  return expected;
}
