import type { LegacyMigrationBaseline, ModulePin, ExtensionPin } from '@storeweave/db';
import type { BaseConfig, ReleaseConfigDefinition } from '@storeweave/config';
import type { ReleaseRoleCatalog } from '@storeweave/authorization';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import type { PlatformModule, RuntimeOptions, StorefrontTheme } from '@storeweave/kernel';
import type { LegacyMediaManifestEntry } from '@storeweave/content';

/** Statically selected by every entrypoint in a release. No runtime discovery. */
export interface ReleaseDefinition<C extends BaseConfig> {
  readonly id: string;
  readonly version: string;
  readonly baseVersion: string;
  readonly config: ReleaseConfigDefinition<C>;
  readonly roles: ReleaseRoleCatalog;
  readonly legacyBaselines: readonly LegacyMigrationBaseline[];
  /** Non-secret schema input used only to construct build-time module metadata. */
  readonly manifestConfig: unknown;
  /** Pure and synchronous. Graph/migration/work metadata must not vary with config or provider contents.
   * Config and providers may only be captured by handlers, which are not invoked during construction. */
  readonly createModules: (context: { config: C; providers: ProviderRegistry }) => readonly PlatformModule[];
  readonly availableExtensions: RuntimeOptions<C>['availableExtensions'];
  readonly availableThemes: Readonly<Record<string, StorefrontTheme>>;
  /** Closed legacy Theme media catalog. Only Commerce carries the Default Theme's B14 source assets. */
  readonly legacyContentMediaManifest?: readonly LegacyMediaManifestEntry[];
}

export interface BuildModuleManifest extends ModulePin {
  readonly baseVersionRange: string;
  readonly requiredDependencies: readonly { name: string; versionRange: string }[];
  readonly optionalDependencies: readonly { name: string; versionRange: string }[];
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
