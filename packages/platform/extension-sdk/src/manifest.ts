import { z, type ZodType, type ZodTypeDef } from 'zod';

type Schema<T> = ZodType<T, ZodTypeDef, any>;
import { EVENT_NAME_PATTERN, PlatformError } from '@storeweave/contracts';
import type { ProviderKind } from './providers';

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const providerDeclarationSchema = z.object({
  kind: z.enum(['payment', 'shipping', 'erp', 'invoice']),
  id: z.string().min(1),
  isDefault: z.boolean().optional(),
});
export type ProviderDeclaration = z.infer<typeof providerDeclarationSchema>;

/** Manifest 的執行期結構驗證（configuration 是 ZodType，另外檢查）。 */
export const manifestShapeSchema = z.object({
  id: z.string().regex(EXTENSION_ID_PATTERN),
  name: z.string().min(1),
  version: z.string().regex(SEMVER),
  /** semver range，例如 `^1.0.0`。 */
  platformVersion: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  subscribedEvents: z.array(z.string().regex(EVENT_NAME_PATTERN)).default([]),
  registeredCommands: z.array(z.string()).default([]),
  registeredQueries: z.array(z.string()).default([]),
  registeredJobs: z.array(z.string().min(1)).default([]),
  registeredProviders: z.array(providerDeclarationSchema).default([]),
  /** 這個 Extension 自己新增的權限鍵（會註冊到 PermissionRegistry）。 */
  declaredPermissions: z.array(z.object({ key: z.string(), description: z.string() })).default([]),
  /** 需要的機密環境變數名稱；只放名稱，永遠不放值。 */
  requiredSecrets: z.array(z.string()).default([]),
});

export interface ExtensionManifest<TConfig = unknown> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly platformVersion: string;
  readonly description?: string;
  readonly permissions: readonly string[];
  /** Configuration Schema：設定檔中 `extensions.<id>.config` 的驗證器。 */
  readonly configuration: Schema<TConfig>;
  readonly subscribedEvents: readonly string[];
  readonly registeredCommands: readonly string[];
  readonly registeredQueries: readonly string[];
  /** Job types are available to release tooling without executing setup(). */
  readonly registeredJobs?: readonly string[];
  readonly registeredProviders: readonly ProviderDeclaration[];
  readonly declaredPermissions?: readonly { key: string; description: string }[];
  readonly requiredSecrets?: readonly string[];
}

export function validateManifestShape(manifest: ExtensionManifest<any>): void {
  const { configuration, ...rest } = manifest;
  const parsed = manifestShapeSchema.safeParse(rest);
  if (!parsed.success) {
    throw PlatformError.validation(`Invalid extension manifest for "${manifest.id ?? '<unknown>'}"`, parsed.error.issues);
  }
  if (!configuration || typeof (configuration as ZodType).safeParse !== 'function') {
    throw PlatformError.validation(`Extension "${manifest.id}" must declare a Zod configuration schema`);
  }
  const assertUnique = (label: string, values: readonly string[]) => {
    if (new Set(values).size !== values.length) {
      throw PlatformError.validation(`Extension "${manifest.id}" declares the same ${label} more than once`);
    }
  };
  assertUnique('permission', manifest.permissions);
  assertUnique('subscribed event', manifest.subscribedEvents);
  assertUnique('command', manifest.registeredCommands);
  assertUnique('query', manifest.registeredQueries);
  assertUnique('job', manifest.registeredJobs ?? []);
  assertUnique('provider', manifest.registeredProviders.map(provider => `${provider.kind}:${provider.id}`));
  assertUnique('declared permission', (manifest.declaredPermissions ?? []).map(permission => permission.key));
  assertUnique('required secret', manifest.requiredSecrets ?? []);
}

export function providerKinds(manifest: ExtensionManifest<any>): ProviderKind[] {
  return [...new Set(manifest.registeredProviders.map((p) => p.kind))];
}
