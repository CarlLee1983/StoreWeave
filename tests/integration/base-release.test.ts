import { randomUUID } from 'node:crypto';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { ADMIN_ACTOR } from './helpers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import type { Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const runtimes: Runtime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function configPath() {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-release-'));
  directories.push(directory);
  const config = join(directory, 'config.yaml');
  writeFileSync(config, JSON.stringify({
    version: 1, store: { id: 'release-test', name: 'Release Test' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
  }));
  return config;
}

describe('selected release bootstrap', () => {
  it('Base starts and migrates without currency, Commerce modules, or a storefront theme', async () => {
    const result = await bootstrapRelease(baseRelease, { configPath: await configPath(), loggerName: 'base-test' });
    const { runtime } = result;
    runtimes.push(runtime);
    expect(result.theme).toBeUndefined();
    expect(runtime.config.store).not.toHaveProperty('currency');
    expect(runtime.modules.map(module => module.name).sort()).toEqual(['platform', 'platform-cache', 'platform-identity', 'platform-ops']);
    expect(Object.keys(runtime.roles).sort()).toEqual(['admin', 'readonly', 'staff']);
    await runtime.migrate();
    await expect(runtime.migrate()).resolves.toEqual([]);
    const tables = await runtime.database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map(row => row.tablename)).toEqual([
      'platform_audit_log', 'platform_cache', 'platform_extension_registry', 'platform_extension_state',
      'platform_idempotency', 'platform_job_quarantine', 'platform_job_schedules', 'platform_jobs', 'platform_migration_baselines', 'platform_migrations', 'platform_outbox',
      'platform_outbox_quarantine', 'platform_outbox_quarantine_audit',
      'platform_password_resets', 'platform_release_history', 'platform_sessions', 'platform_users', 'platform_worker_heartbeat',
    ]);
  });

  it('Base HTTP authenticates with Base permissions and exposes no Commerce routes or assets', async () => {
    const result = await bootstrapRelease(baseRelease, { configPath: await configPath(), loggerName: 'base-http' });
    const { runtime } = result;
    runtimes.push(runtime);
    await runtime.migrate();
    const password = 'base-http-passphrase';
    await runtime.commands.execute('platform.identity.createUser', {
      email: 'base@example.com', password, displayName: 'Base Operator', role: 'staff',
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    runtime.config.auth.tokens.push({ name: 'readonly', role: 'readonly', secretRef: 'B02_BASE_TOKEN' });
    const getSecret = runtime.secrets.get;
    runtime.secrets.get = name => name === 'B02_BASE_TOKEN' ? 'base-token' : getSecret(name);
    const app = await createReleaseServer({ runtime, httpAdapter,
      release: { version: baseRelease.version, configPath: result.loaded.sourcePath } });
    try {
      expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/system/jobs/dead' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/system/jobs/dead',
        headers: { authorization: 'Bearer base-token' } })).statusCode).toBe(200);
      for (const url of ['/', '/api/v1/products', '/api/v1/orders', '/mcp', '/storefront-assets/woven-day-hero.png']) {
        expect((await app.inject({ url })).statusCode, url).toBe(404);
      }
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { email: 'base@example.com', password } });
      expect(login.statusCode).toBe(200);
      expect(login.json().data).toMatchObject({ role: 'staff', cartNotice: null });
      const cookie = login.cookies.find(cookie => cookie.name === SESSION_COOKIE);
      expect(cookie).toBeDefined();
      const me = await app.inject({ url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: cookie!.value } });
      expect(me.statusCode).toBe(200);
      expect(me.json().data.role).toBe('staff');
    } finally { await app.close(); }
  });

  it('Commerce selects its original modules and default theme through the same bootstrap', async () => {
    const result = await bootstrapRelease(commerceRelease, { configPath: await configPath(), loggerName: 'commerce-test' });
    runtimes.push(result.runtime);
    expect(result.theme?.id).toBe('default');
    expect(result.runtime.config.store.currency).toBe('TWD');
    expect(result.runtime.modules).toHaveLength(18);
    expect(result.runtime.actorForRole('staff').permissions).toContain('erp:write');
    await result.runtime.migrate();
    await expect(result.runtime.migrate()).resolves.toEqual([]);
    const tables = await result.runtime.database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'catalog_products'",
    );
    expect(tables.rows).toEqual([{ tablename: 'catalog_products' }]);
  });
});
