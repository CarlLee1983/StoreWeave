import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfTokenFor } from '@storeweave/identity';
import type { Runtime } from '@storeweave/kernel';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';

/**
 * 後台帳號管理與 API token 的 HTTP 入口（B13 片4）。B08 交付時它們只有 Bus 與 CLI，
 * 做不出帳號管理 UI。跑在 base release 上：這條路徑不需要任何商務模組。
 */
process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');

const runtimes: Runtime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ADMIN_PASSWORD = 'admin-console-passphrase';
const STAFF_PASSWORD = 'staff-console-passphrase';

async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-accounts-'));
  directories.push(directory);
  const configPath = join(directory, 'config.yaml');
  writeFileSync(configPath, JSON.stringify({
    version: 1, store: { id: 'accounts-test', name: 'Accounts Test' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
    storage: { localRoot: join(directory, 'storage') },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  const result = await bootstrapRelease(baseRelease, { configPath, loggerName: 'accounts-test' });
  runtimes.push(result.runtime);
  await result.runtime.migrate();
  const app = await createReleaseServer({
    runtime: result.runtime, theme: result.theme, httpAdapter,
    release: { version: baseRelease.version, configPath: result.loaded.sourcePath },
  });

  const signIn = async (email: string, password: string, role: string) => {
    await result.runtime.commands.execute('platform.identity.createUser',
      { email, password, displayName: role, role },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    const session = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    return {
      cookies: { [SESSION_COOKIE]: session },
      headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': randomUUID() },
    };
  };
  return { runtime: result.runtime, app, signIn };
}

describe('operator accounts over HTTP', () => {
  it('lists, creates and disables an operator, and refuses a reader', async () => {
    const { app, signIn } = await start();
    try {
      const admin = await signIn('owner@example.com', ADMIN_PASSWORD, 'admin');

      const created = await app.inject({
        method: 'POST', url: '/api/v1/users', cookies: admin.cookies, headers: admin.headers,
        payload: { email: 'new-staff@example.com', password: STAFF_PASSWORD, displayName: 'New Staff', role: 'staff' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const userId = created.json().data.id as string;

      const listed = await app.inject({ url: '/api/v1/users', cookies: admin.cookies });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data.items.map((item: { email: string }) => item.email))
        .toEqual(expect.arrayContaining(['owner@example.com', 'new-staff@example.com']));

      const disabled = await app.inject({
        method: 'POST', url: `/api/v1/users/${userId}/status`, cookies: admin.cookies,
        headers: { ...admin.headers, 'idempotency-key': randomUUID() }, payload: { status: 'disabled' },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json().data.status).toBe('disabled');

      // 隱藏選單不是權限檢查：readonly 直接打這條路由仍然被擋（B13 片3 的出口條件）。
      const reader = await signIn('reader@example.com', 'reader-console-passphrase', 'readonly');
      const refused = await app.inject({
        method: 'POST', url: '/api/v1/users', cookies: reader.cookies, headers: reader.headers,
        payload: { email: 'nope@example.com', password: STAFF_PASSWORD, displayName: 'Nope', role: 'staff' },
      });
      expect(refused.statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/users', cookies: reader.cookies })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe('API tokens over HTTP', () => {
  it('issues a usable token once, lists it without the secret, and revokes it', async () => {
    const { app, signIn } = await start();
    try {
      const admin = await signIn('token-owner@example.com', ADMIN_PASSWORD, 'admin');

      const issued = await app.inject({
        method: 'POST', url: '/api/v1/system/api-tokens', cookies: admin.cookies, headers: admin.headers,
        payload: { name: 'ci-readonly', role: 'readonly', ttlDays: 30 },
      });
      expect(issued.statusCode, issued.body).toBe(201);
      const secret = issued.json().data.secret as string;

      const authorized = await app.inject({ url: '/api/v1/system/jobs/dead', headers: { authorization: `Bearer ${secret}` } });
      expect(authorized.statusCode).toBe(200);

      const listed = await app.inject({ url: '/api/v1/system/api-tokens', cookies: admin.cookies });
      expect(listed.statusCode).toBe(200);
      const [token] = listed.json().data.items as { name: string; role: string; secret?: string }[];
      expect(token).toMatchObject({ name: 'ci-readonly', role: 'readonly' });
      // 秘密只在簽發那一次出現，系統自己也讀不回來（ADR 0043）。
      expect(token).not.toHaveProperty('secret');

      const revoked = await app.inject({
        method: 'POST', url: '/api/v1/system/api-tokens/ci-readonly/revoke',
        cookies: admin.cookies, headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const afterRevoke = await app.inject({ url: '/api/v1/system/jobs/dead', headers: { authorization: `Bearer ${secret}` } });
      expect(afterRevoke.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('refuses a role that may not be used by a token, and a staff operator issuing one', async () => {
    const { app, signIn } = await start();
    try {
      const admin = await signIn('token-admin@example.com', ADMIN_PASSWORD, 'admin');
      const refusedRole = await app.inject({
        method: 'POST', url: '/api/v1/system/api-tokens', cookies: admin.cookies, headers: admin.headers,
        payload: { name: 'member-token', role: 'member', ttlDays: 30 },
      });
      expect(refusedRole.statusCode).toBe(400);

      const staff = await signIn('token-staff@example.com', STAFF_PASSWORD, 'staff');
      const refusedActor = await app.inject({
        method: 'POST', url: '/api/v1/system/api-tokens', cookies: staff.cookies, headers: staff.headers,
        payload: { name: 'staff-token', role: 'readonly', ttlDays: 30 },
      });
      expect(refusedActor.statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
