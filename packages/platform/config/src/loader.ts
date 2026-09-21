import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** The portable portion of a selected ReleaseDefinition needed to select its config contribution. */
export interface ConfigReleaseManifest {
  readonly id: string;
  readonly targets: { readonly config: { readonly key: string } };
}

export interface ConfigReleaseDefinition<Manifest extends ConfigReleaseManifest = ConfigReleaseManifest> {
  readonly manifest: Manifest;
}

export interface ReleaseConfigProjection<C extends BaseConfig> {
  readonly definition: ReleaseConfigDefinition<C>;
  readonly defaultFilename: string;
}

export interface ReleaseConfigProjectionContext<Manifest> {
  readonly manifest: Manifest;
  readonly declaration: { readonly key: string };
  readonly target: 'config';
}

/** Structural twin of a config target factory; config stays independent of the release package. */
export interface ReleaseConfigProjectionFactory<Manifest, C extends BaseConfig> {
  readonly target: 'config';
  readonly key: string;
  readonly resolve: (context: ReleaseConfigProjectionContext<Manifest>) => ReleaseConfigProjection<C>;
}

export interface ResolvedReleaseConfig<C extends BaseConfig> extends ReleaseConfigProjection<C> {
  readonly releaseId: string;
  /** The declared config target key is the stable schema identifier. */
  readonly schemaId: string;
}

/** Selects exactly one config contribution by the key declared by the selected ReleaseDefinition. */
export function resolveReleaseConfigProjection<C extends BaseConfig, Manifest extends ConfigReleaseManifest>(
  selected: ConfigReleaseDefinition<Manifest> | undefined,
  factories: readonly ReleaseConfigProjectionFactory<Manifest, C>[],
): ResolvedReleaseConfig<C> {
  if (selected === undefined || selected === null) {
    throw PlatformError.validation('No selected ReleaseDefinition was supplied for config resolution');
  }
  const manifest = selected.manifest;
  if (!manifest || typeof manifest.id !== 'string' || manifest.id.trim() === '') {
    throw PlatformError.validation('Selected ReleaseDefinition has no release id for config resolution');
  }
  const releaseId = manifest.id;
  const declaration = manifest.targets?.config;
  if (!declaration || typeof declaration.key !== 'string' || declaration.key.trim() === '') {
    throw PlatformError.validation(`Release "${releaseId}" has no config schema declaration`);
  }
  const schemaId = declaration.key;
  const matches = factories.filter(factory => factory.target === 'config' && factory.key === schemaId);
  if (matches.length === 0) {
    throw PlatformError.validation(`Release "${releaseId}" is missing config schema "${schemaId}" contribution`);
  }
  if (matches.length > 1) {
    throw PlatformError.validation(`Release "${releaseId}" has duplicate config schema "${schemaId}" contributions`);
  }

  let contribution: ReleaseConfigProjection<C>;
  try {
    contribution = matches[0].resolve({ manifest, declaration, target: 'config' });
  } catch (error) {
    throw PlatformError.validation(
      `Release "${releaseId}" config schema "${schemaId}" contribution could not be resolved`,
      error,
    );
  }
  if (!contribution || !contribution.definition?.schema || typeof contribution.definition.schema.safeParse !== 'function' ||
      typeof contribution.defaultFilename !== 'string' || contribution.defaultFilename.trim() === '' ||
      contribution.defaultFilename === '.' || contribution.defaultFilename === '..' ||
      basename(contribution.defaultFilename) !== contribution.defaultFilename || /[\\/\0]/.test(contribution.defaultFilename)) {
    throw PlatformError.validation(`Release "${releaseId}" config schema "${schemaId}" has an incomplete contribution`);
  }
  return { ...contribution, releaseId, schemaId };
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

/** Loads a selected projection, using its filename with the configured default search directories. */
export function loadReleaseConfigProjection<C extends BaseConfig>(
  projection: ResolvedReleaseConfig<C>, explicitPath?: string,
): LoadedConfig<C> {
  const definition = {
    ...projection.definition,
    defaultPaths: projection.definition.defaultPaths.map(path => join(dirname(path), projection.defaultFilename)),
  };
  try {
    return loadReleaseConfig(definition, explicitPath);
  } catch (error) {
    const message = error instanceof PlatformError
      ? error.message
      : 'Configuration could not be parsed';
    const details = error instanceof PlatformError ? error.details : undefined;
    throw PlatformError.validation(`Release "${projection.releaseId}" config schema "${projection.schemaId}": ${message}`, details);
  }
}

/** 只驗證設定檔，供 `commerce doctor` 與 install 使用。 */
export function validateConfigFile(path: string): { ok: true; config: CommerceConfig } | { ok: false; errors: string[] } {
  try {
    return { ok: true, config: loadConfig(path).config };
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
}
