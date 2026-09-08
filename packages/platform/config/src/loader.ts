import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PlatformError } from '@storeweave/contracts';
import { z } from 'zod';
import { baseConfigSchema, commerceConfigSchema, type BaseConfig, type CommerceConfig } from './schema';
import { createSecretProvider, type SecretProvider } from './secrets';

const INTERPOLATION = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/** 把字串裡的 `${VAR}` / `${VAR:-default}` 換成環境變數值。 */
export function interpolate(raw: string, lookup: (name: string) => string | undefined, missing: string[] = []): string {
  return raw.replace(INTERPOLATION, (_match, name: string, fallback?: string) => {
    const value = lookup(name);
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
}

/**
 * 只替換「值」，不碰註解與鍵。
 * 先解析 YAML 再走訪，避免文件裡示範用的 ${VAR} 被誤判成必要環境變數。
 */
function interpolateValues(value: unknown, lookup: (name: string) => string | undefined, missing: string[]): unknown {
  if (typeof value === 'string') return interpolate(value, lookup, missing);
  if (Array.isArray(value)) return value.map((v) => interpolateValues(v, lookup, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateValues(v, lookup, missing)]),
    );
  }
  return value;
}

export interface ReleaseConfigDefinition<C extends BaseConfig> {
  readonly schema: z.ZodType<C, z.ZodTypeDef, unknown>;
  readonly envNames: readonly string[];
  readonly defaultPaths: readonly string[];
  readonly defaultSecretFile: string;
}

export const commerceConfigDefinition: ReleaseConfigDefinition<CommerceConfig> = {
  schema: commerceConfigSchema,
  envNames: ['STOREWEAVE_CONFIG', 'COMMERCE_CONFIG'],
  defaultPaths: ['/etc/commerce/commerce.yaml', './commerce.yaml'],
  defaultSecretFile: commerceConfigSchema.shape.secrets.parse({}).file,
};

export const baseConfigDefinition: ReleaseConfigDefinition<BaseConfig> = {
  schema: baseConfigSchema,
  envNames: ['STOREWEAVE_CONFIG'],
  defaultPaths: ['/etc/storeweave/storeweave.yaml', './storeweave.yaml'],
  defaultSecretFile: baseConfigSchema.shape.secrets.parse({}).file,
};

export interface LoadedConfig<C extends BaseConfig = CommerceConfig> {
  config: C;
  secrets: SecretProvider;
  sourcePath: string;
}

export function resolveConfigPath(
  explicit?: string,
  definition: Pick<ReleaseConfigDefinition<BaseConfig>, 'envNames' | 'defaultPaths'> = commerceConfigDefinition,
): string {
  const selected = explicit ?? definition.envNames.map(name => process.env[name]).find(value => Boolean(value));
  const candidates = selected ? [selected] : definition.defaultPaths;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw PlatformError.validation(`No configuration file found. Looked at: ${candidates.join(', ')}`);
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  return loadReleaseConfig(commerceConfigDefinition, explicitPath);
}

export function loadReleaseConfig<C extends BaseConfig>(
  definition: ReleaseConfigDefinition<C>, explicitPath?: string,
): LoadedConfig<C> {
  const sourcePath = resolveConfigPath(explicitPath, definition);
  const parsedYaml: unknown = parseYaml(readFileSync(sourcePath, 'utf8'));
  const mapping = z.record(z.unknown()).safeParse(parsedYaml);
  if (!mapping.success) {
    throw PlatformError.validation(`Configuration at ${sourcePath} is empty or not a mapping`);
  }
  const secretOptions = baseConfigSchema.shape.secrets.removeDefault().extend({
    file: z.string().default(definition.defaultSecretFile),
  }).safeParse(mapping.data.secrets === undefined ? {} : mapping.data.secrets);
  if (!secretOptions.success) throw PlatformError.validation(`Invalid secrets configuration (${sourcePath})`);
  const secrets = createSecretProvider(secretOptions.data);

  const missing: string[] = [];
  const interpolated = interpolateValues(parsedYaml, (name) => secrets.get(name), missing);
  if (missing.length > 0) {
    throw PlatformError.validation(
      `Missing required environment variables referenced by ${sourcePath}: ${[...new Set(missing)].join(', ')}`,
    );
  }

  const parsed = definition.schema.safeParse(interpolated);
  if (!parsed.success) {
    throw PlatformError.validation(
      `Invalid configuration (${sourcePath}):\n${parsed.error.issues.map((i) => ` - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')}`,
    );
  }
  return { config: parsed.data, secrets, sourcePath };
}

/** 只驗證設定檔，供 `commerce doctor` 與 install 使用。 */
export function validateConfigFile(path: string): { ok: true; config: CommerceConfig } | { ok: false; errors: string[] } {
  try {
    return { ok: true, config: loadConfig(path).config };
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
}
