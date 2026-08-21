import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PlatformError } from '@storeweave/contracts';
import { commerceConfigSchema, type CommerceConfig } from './schema';
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

export interface LoadedConfig {
  config: CommerceConfig;
  secrets: SecretProvider;
  sourcePath: string;
}

export function resolveConfigPath(explicit?: string): string {
  const candidates = [explicit, process.env.COMMERCE_CONFIG, '/etc/commerce/commerce.yaml', './commerce.yaml']
    .filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw PlatformError.validation(`No commerce.yaml found. Looked at: ${candidates.join(', ')}`);
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const sourcePath = resolveConfigPath(explicitPath);
  const parsedYaml = parseYaml(readFileSync(sourcePath, 'utf8')) as Record<string, any> | null;
  if (!parsedYaml || typeof parsedYaml !== 'object') {
    throw PlatformError.validation(`commerce.yaml at ${sourcePath} is empty or not a mapping`);
  }

  const secrets = createSecretProvider({
    provider: (parsedYaml.secrets?.provider ?? 'env') as 'env' | 'file',
    file: (parsedYaml.secrets?.file ?? '/etc/commerce/commerce.env') as string,
  });

  const missing: string[] = [];
  const interpolated = interpolateValues(parsedYaml, (name) => secrets.get(name), missing);
  if (missing.length > 0) {
    throw PlatformError.validation(
      `Missing required environment variables referenced by ${sourcePath}: ${[...new Set(missing)].join(', ')}`,
    );
  }

  const parsed = commerceConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    throw PlatformError.validation(
      `Invalid commerce.yaml (${sourcePath}):\n${parsed.error.issues.map((i) => ` - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')}`,
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
