import { readFileSync, existsSync } from 'node:fs';

/** 解析 dotenv 風格檔案。不做 export、不支援指令替換，避免意外執行。 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface SecretProvider {
  get(name: string): string | undefined;
  has(name: string): boolean;
  /** 只回傳名稱，永遠不回傳值。 */
  listNames(): string[];
}

export function createSecretProvider(options: { provider: 'env' | 'file'; file: string }): SecretProvider {
  const fromFile: Record<string, string> = {};
  if (options.provider === 'file' && existsSync(options.file)) {
    Object.assign(fromFile, parseEnvFile(readFileSync(options.file, 'utf8')));
  }
  const lookup = (name: string) => process.env[name] ?? fromFile[name];
  return {
    get: lookup,
    has: (name) => lookup(name) !== undefined && lookup(name) !== '',
    listNames: () => [...new Set([...Object.keys(fromFile), ...Object.keys(process.env)])].sort(),
  };
}
