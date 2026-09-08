import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseConfigDefinition, baseConfigSchema, commerceConfigSchema, loadConfig, loadReleaseConfig,
} from '@storeweave/config';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-config-'));
  directories.push(directory);
  const file = join(directory, 'config.yaml');
  writeFileSync(file, body);
  return file;
}
const base = { version: 1, store: { id: 'base-test', name: 'Base' }, database: { url: 'postgres://localhost/base' } };
const yaml = 'version: 1\nstore: { id: base-test, name: Base }\ndatabase: { url: "${B02_TEST_DATABASE}" }\n';

describe('release configuration', () => {
  it('Base has no currency, Commerce provider requirement, or enabled Commerce UI', () => {
    const config = baseConfigSchema.parse(base);
    expect(config.store).not.toHaveProperty('currency');
    expect(config.extensions).toEqual([]);
    expect(config.theme.id).toBe('none');
    expect(config.admin.enabled).toBe(false);
    expect(config.mcp.enabled).toBe(false);
    expect(config.paths.dataDir).toBe('/var/lib/storeweave');
    expect(baseConfigSchema.safeParse({ ...base, store: { ...base.store, currency: 'TWD' } }).success).toBe(false);
    expect(baseConfigSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
  });

  it('rejects a dedupe horizon shorter than either terminal payload retention period before runtime startup', () => {
    expect(baseConfigSchema.safeParse({ ...base, worker: {
      completedPayloadRetentionDays: 8, cancelledPayloadRetentionDays: 7, dedupeHorizonDays: 7,
    } }).success).toBe(false);
    expect(baseConfigSchema.parse(base).worker).toMatchObject({
      completedPayloadRetentionDays: 7, cancelledPayloadRetentionDays: 7, dedupeHorizonDays: 30,
    });
  });

  it('preserves Commerce v1 defaults and static-token restrictions', () => {
    const config = commerceConfigSchema.parse(base);
    expect(config.store.currency).toBe('TWD');
    expect(config.theme.id).toBe('default');
    expect(config.paths.dataDir).toBe('/var/lib/commerce');
    expect(config.auth.sessionTtlMinutes).toEqual({ operator: 720, customer: 43200 });
    for (const role of ['customer', 'storefront', 'constructor']) {
      expect(commerceConfigSchema.safeParse({ ...base, auth: { tokens: [{ name: 'bad', role, secretRef: 'TOKEN' }] } }).success).toBe(false);
    }
  });

  it('defaults CORS off and accepts only canonical HTTP(S) origins', () => {
    for (const schema of [baseConfigSchema, commerceConfigSchema]) {
      expect(schema.parse(base).http.cors).toEqual({ allowedOrigins: [], credentials: false });
      expect(schema.parse({ ...base, http: { cors: { allowedOrigins: ['HTTPS://Console.Example:443/'] } } }).http.cors)
        .toEqual({ allowedOrigins: ['https://console.example'], credentials: false });
    }
    expect(baseConfigSchema.parse({ ...base, http: { cors: { allowedOrigins: ['HTTP://[::1]:80/', 'https://[2001:DB8::1]:443'] } } }).http.cors.allowedOrigins)
      .toEqual(['http://[::1]', 'https://[2001:db8::1]']);

    const invalid = [
      ' https://console.example', 'https://console.example ', 'https://console\\.example',
      'https://console.example?', 'https://console.example#', 'https://console.example/path',
      'https://console.example/./', 'https://console.example/path/..', 'https://@console.example',
      'https://console\t.example', 'https://console.example\n', 'https://user:password@console.example',
      'https://console.example\u0001', 'https://console.example\u007f', 'https://console.example:', 'https://console.example:/',
      'https://*.example.test', 'https://*', 'https://%2A.example.test', 'ftp://console.example', 'not a url', 'null', '*',
    ];
    for (const origin of invalid) {
      const parse = () => baseConfigSchema.safeParse({ ...base, http: { cors: { allowedOrigins: [origin] } } });
      expect(parse, origin).not.toThrow();
      expect(parse().success, origin).toBe(false);
    }
    expect(baseConfigSchema.safeParse({ ...base, http: { cors: { allowedOrigins: ['https://CONSOLE.example:443', 'https://console.example/'] } } }).success).toBe(false);
    expect(baseConfigSchema.safeParse({ ...base, http: { cors: { credentials: true } } }).success).toBe(false);
  });

  it('loads either selected schema and preserves interpolation without exposing values in errors', () => {
    const file = fixture(yaml);
    vi.stubEnv('B02_TEST_DATABASE', 'postgres://localhost/test');
    expect(loadReleaseConfig(baseConfigDefinition, file).config.store).not.toHaveProperty('currency');
    expect(loadConfig(file).config.store.currency).toBe('TWD');
    vi.stubEnv('B02_TEST_DATABASE', '');
    expect(() => loadReleaseConfig(baseConfigDefinition, file)).toThrow('B02_TEST_DATABASE');
  });

  it('prefers the generic env alias and never silently replaces an explicit missing path', () => {
    const file = fixture(yaml);
    vi.stubEnv('B02_TEST_DATABASE', 'postgres://localhost/test');
    vi.stubEnv('STOREWEAVE_CONFIG', file);
    vi.stubEnv('COMMERCE_CONFIG', `${file}.missing`);
    expect(loadConfig().sourcePath).toBe(file);
    expect(() => loadConfig(`${file}.explicit-missing`)).toThrow('explicit-missing');
  });

  it('rejects malformed secret configuration before constructing a secret provider', () => {
    for (const secrets of ['[]', 'null', 'false', '{ provider: unknown }']) {
      const file = fixture(yaml + `secrets: ${secrets}\n`);
      expect(() => loadReleaseConfig(baseConfigDefinition, file)).toThrow('Invalid secrets configuration');
    }
  });
});
