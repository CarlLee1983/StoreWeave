import { catalogDigest, validateWorkOwnership } from '@storeweave/db';
import { noopLogger } from '@storeweave/contracts';
import type { BaseConfig, ReleaseConfigDefinition } from '@storeweave/config';
import type { ReleaseRoleCatalog } from '@storeweave/authorization';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { JobQueue } from '@storeweave/jobs';
import { EventBus } from '@storeweave/event-bus';
import { OutboxStore } from '@storeweave/outbox';
import { PermissionRegistry } from '@storeweave/authorization';
import { composeRuntimeModules, projectExtensionPin, projectModulePins, type PlatformModule, type RuntimeOptions, type StorefrontTheme } from '@storeweave/kernel';
import type { LegacyMigrationBaseline, ModulePin, ExtensionPin } from '@storeweave/db';
import { validateReleaseDefinition, type ReleaseDefinition } from './release-definition';
import { resolveConfigProjection, type ConfigProjectionFactory } from './config';
import { resolveStorefrontProjection, type StorefrontProjectionFactory } from './storefront';

type RuntimeConfigProjectionFactory<Contribution> = ConfigProjectionFactory<Contribution> & { readonly source: string };
type RuntimeStorefrontProjectionFactory<Contribution> = StorefrontProjectionFactory<Contribution> & { readonly source: string };

export interface RuntimeConfigProjection<C extends BaseConfig = BaseConfig> {
  readonly definition: ReleaseConfigDefinition<C>;
  readonly defaultFilename: string;
}

export interface RuntimeStorefrontProjection {
  readonly themes: Readonly<Record<string, StorefrontTheme>>;
  readonly themeAssets?: string;
}

/** Executable contributions paired with a target-safe serializable manifest. */
export interface RuntimeReleaseDefinition<C extends BaseConfig = BaseConfig> {
  readonly manifest: ReleaseDefinition['manifest'];
  readonly id: string;
  readonly version: string;
  readonly baseVersion: string;
  readonly configProjection: RuntimeConfigProjection<C>;
  readonly storefrontProjection: RuntimeStorefrontProjection;
  readonly configProjectionSource: string;
  readonly storefrontProjectionSource: string;
  readonly config: ReleaseConfigDefinition<C>;
  readonly roles: ReleaseRoleCatalog;
  readonly legacyBaselines: readonly LegacyMigrationBaseline[];
  /** Non-secret schema input used only to construct build-time module metadata. */
  readonly manifestConfig: unknown;
  /** Pure and synchronous. Graph/migration/work metadata must not vary with config or provider contents. */
  readonly createModules: (context: { config: C; providers: ProviderRegistry }) => readonly PlatformModule[];
  readonly availableExtensions: RuntimeOptions<C>['availableExtensions'];
  readonly availableThemes: Readonly<Record<string, StorefrontTheme>>;
}

export interface RuntimeReleaseContributions<C extends BaseConfig = BaseConfig> {
  readonly config: RuntimeConfigProjectionFactory<RuntimeConfigProjection<C>>;
  readonly storefront: RuntimeStorefrontProjectionFactory<RuntimeStorefrontProjection>;
  readonly roles: ReleaseRoleCatalog;
  readonly legacyBaselines: readonly LegacyMigrationBaseline[];
  readonly manifestConfig: unknown;
  readonly createModules: RuntimeReleaseDefinition<C>['createModules'];
  readonly availableExtensions: RuntimeOptions<C>['availableExtensions'];
}

/** Derive product identity/version from the validated root manifest exactly once. */
export function defineRuntimeRelease<C extends BaseConfig>(
  definition: ReleaseDefinition,
  contributions: RuntimeReleaseContributions<C>,
): RuntimeReleaseDefinition<C> {
  const validatedDefinition = validateReleaseDefinition(definition);
  const manifest = validatedDefinition.manifest;
  const baseVersion = manifest.metadata && typeof manifest.metadata === 'object' && !Array.isArray(manifest.metadata)
    ? (manifest.metadata as Record<string, unknown>).baseVersion : undefined;
  if (typeof baseVersion !== 'string' || baseVersion.trim() === '') {
    throw new Error(`Release "${manifest.id}" manifest metadata must declare baseVersion`);
  }
  const configProjection = resolveConfigProjection(validatedDefinition, contributions.config);
  const storefrontProjection = resolveStorefrontProjection(validatedDefinition, contributions.storefront);
  const release: RuntimeReleaseDefinition<C> = {
    manifest,
    id: manifest.id,
    version: manifest.version,
    baseVersion,
    configProjection,
    storefrontProjection,
    configProjectionSource: contributions.config.source,
    storefrontProjectionSource: contributions.storefront.source,
    config: configProjection.definition,
    availableThemes: storefrontProjection.themes,
    ...withoutProjectionFactories(contributions),
  };
  assertReleaseDefinitionComposition(release);
  return release;
}

function withoutProjectionFactories<C extends BaseConfig>(contributions: RuntimeReleaseContributions<C>) {
  const { config: _config, storefront: _storefront, ...runtimeContributions } = contributions;
  return runtimeContributions;
}

export interface BuildModuleManifest extends ModulePin {
  readonly baseVersionRange: string;
  readonly requiredDependencies: readonly { name: string; versionRange: string }[];
  readonly optionalDependencies: readonly { name: string; versionRange: string }[];
  /** Declared Keyring derivation authority; affects runtime security behavior. */
  readonly signingKeyPurposes: readonly string[];
}

export interface BuildExtensionManifest extends ExtensionPin {
  readonly platformVersion: string;
}

export interface ReleaseBuildManifest {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly releaseVersion: string;
  readonly baseVersion: string;
  readonly rolesChecksum: string;
  readonly modules: readonly BuildModuleManifest[];
  readonly availableExtensions: readonly BuildExtensionManifest[];
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function projectModules(modules: readonly PlatformModule[]): BuildModuleManifest[] {
  return projectModulePins(modules).map(pin => {
    const module = modules.find(module => module.name === pin.id)!;
    return {
      ...pin,
      baseVersionRange: module.baseVersionRange,
      requiredDependencies: [...module.dependencies?.required ?? []].sort((a, b) => compare(a.name, b.name)),
      optionalDependencies: [...module.dependencies?.optional ?? []].sort((a, b) => compare(a.name, b.name)),
      signingKeyPurposes: [...module.runtimeSecurity?.signingKeyPurposes ?? []].sort(compare),
    };
  });
}

export function projectReleaseManifest<C extends BaseConfig>(
  release: RuntimeReleaseDefinition<C>, releaseModules: readonly PlatformModule[],
): ReleaseBuildManifest {
  const modules = projectModules(compose(release, releaseModules));
  const availableExtensions = Object.entries(release.availableExtensions).map(([id, definition]): BuildExtensionManifest => {
    if (id !== definition.manifest.id) throw new Error(`Extension catalog key does not match manifest id: ${id}`);
    return { ...projectExtensionPin(definition, release.baseVersion), platformVersion: definition.manifest.platformVersion };
  }).sort((a, b) => compare(a.id, b.id));
  validateWorkOwnership([...modules, ...availableExtensions]);
  return {
    schemaVersion: 1,
    releaseId: release.id,
    releaseVersion: release.version,
    baseVersion: release.baseVersion,
    rolesChecksum: catalogDigest(release.roles),
    modules,
    availableExtensions,
  };
}

/** Sorted permissions declared by the release's composed modules and available extensions. */
export function projectReleasePermissionCatalog<C extends BaseConfig>(
  release: RuntimeReleaseDefinition<C>, releaseModules: readonly PlatformModule[],
): readonly string[] {
  const registry = new PermissionRegistry();
  for (const module of compose(release, releaseModules)) registry.registerMany(module.permissions ?? []);
  for (const [id, extension] of Object.entries(release.availableExtensions)) {
    if (id !== extension.manifest.id) throw new Error(`Extension catalog key does not match manifest id: ${id}`);
    registry.registerMany((extension.manifest.declaredPermissions ?? []).map(permission => ({ ...permission, owner: extension.manifest.id })));
  }
  return registry.list().map(permission => permission.key);
}

/** Reads only declarations; it does not read secrets or call extension setup/handlers. */
export function buildReleasePermissionCatalog<C extends BaseConfig>(release: RuntimeReleaseDefinition<C>): readonly string[] {
  const config = release.config.schema.parse(release.manifestConfig);
  const modules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
  return projectReleasePermissionCatalog(release, modules);
}

/** Reads no store files/secrets and never calls extension setup or module handlers. */
export function buildReleaseManifest<C extends BaseConfig>(release: RuntimeReleaseDefinition<C>): ReleaseBuildManifest {
  const config = release.config.schema.parse(release.manifestConfig);
  const modules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
  return projectReleaseManifest(release, modules);
}

export function assertReleaseComposition<C extends BaseConfig>(
  release: RuntimeReleaseDefinition<C>, modules: readonly PlatformModule[],
): ReleaseBuildManifest {
  const expected = buildReleaseManifest(release);
  if (catalogDigest(projectReleaseManifest(release, modules)) !== catalogDigest(expected)) {
    throw new Error(`Release "${release.id}" module metadata varies with runtime configuration`);
  }
  return expected;
}

function assertReleaseDefinitionComposition<C extends BaseConfig>(release: RuntimeReleaseDefinition<C>): void {
  const config = release.config.schema.parse(release.manifestConfig);
  const modules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
  const actualModules = modules.map(module => module.name);
  const actualThemes = Object.keys(release.availableThemes);
  const actualExtensions = Object.keys(release.availableExtensions);
  assertSelection(release.manifest.selected.modules, actualModules, 'modules', release.id);
  assertSelection(release.manifest.selected.themes, actualThemes, 'themes', release.id);
  assertSelection(release.manifest.selected.extensions, actualExtensions, 'extensions', release.id);
  compose(release, modules);
}

function assertSelection(expected: readonly string[], actual: readonly string[], kind: string, releaseId: string): void {
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`Release "${releaseId}" manifest ${kind} selection does not match its executable registry`);
  }
}

function compose<C extends BaseConfig>(release: RuntimeReleaseDefinition<C>, modules: readonly PlatformModule[]): readonly PlatformModule[] {
  return composeRuntimeModules({
    modules,
    roles: release.roles,
    platformVersion: release.baseVersion,
    jobs: new JobQueue(),
    events: new EventBus(),
    outbox: new OutboxStore(),
    logger: noopLogger,
    scheduler: () => { throw new Error('Release projection has no scheduler'); },
  });
}
