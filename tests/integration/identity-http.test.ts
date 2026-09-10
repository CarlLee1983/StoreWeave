import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Runtime } from '@storeweave/kernel';
import { csrfTokenFor } from '@storeweave/identity';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/base';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { createTestDatabase } from './helpers';

let directory: string;
let runtime: Runtime;
let app: NestFastifyApplication;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-identity-http-'));
  const configPath = join(directory, 'config.json');
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    store: { id: 'identity-http', name: 'Identity HTTP' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  const boot = await bootstrapRelease(release, { configPath, loggerName: 'identity-http' });
  runtime = boot.runtime;
  await runtime.migrate();
  app = await createReleaseServer({ runtime, httpAdapter, release: { version: release.version, configPath } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown, cookie?: string) => app.inject({
  method: 'POST', url, payload: payload ?? {},
  ...(cookie
    ? { cookies: { [SESSION_COOKIE]: cookie }, headers: { 'x-csrf-token': csrfTokenFor(cookie) } }
    : {}),
});

async function register(email: string, password = 'member-password') {
  const res = await post('/api/v1/auth/register', { email, password });
  return { res, session: res.cookies.find(cookie => cookie.name === SESSION_COOKIE)?.value };
}

async function latestToken(templateId: string, email?: string): Promise<string> {
  const rows = await runtime.database.pool.query<{ recipients: { email: string }[]; text_body: string }>(
    `SELECT recipients, text_body FROM public.platform_mail_messages
     WHERE template_id = $1 ORDER BY created_at DESC`, [templateId]);
  const row = rows.rows.find(candidate => !email || candidate.recipients.some(to => to.email === email));
  if (!row) throw new Error(`No ${templateId} mail for ${email ?? 'anyone'}`);
  return new URL(/https?:\/\/\S+/.exec(row.text_body)![0]).searchParams.get('token')!;
}

const verifiedAt = async (email: string) => (await runtime.database.pool.query<{ email_verified_at: Date | null }>(
  'SELECT email_verified_at FROM platform_users WHERE lower(email) = lower($1)', [email])).rows[0]?.email_verified_at ?? null;

describe('base identity over HTTP', () => {
  it('registers a member without any commerce profile and signs them in unverified', async () => {
    const { res, session } = await register('member1@example.test');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ email: 'member1@example.test', role: 'member' });
    expect(session).toBeTruthy();
    // 註冊當下信箱還沒驗證：能登入不等於地址是他的。
    expect(await verifiedAt('member1@example.test')).toBeNull();

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: session! } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.role).toBe('member');

    const token = await latestToken('identity.email-verification', 'member1@example.test');
    const verified = await post('/api/v1/auth/verify-email', { token });
    expect(verified.statusCode).toBe(200);
    expect(await verifiedAt('member1@example.test')).not.toBeNull();
  });

  it('refuses a second account on the same address without saying the address is taken', async () => {
    await register('member2@example.test');
    const again = await register('member2@example.test');
    expect(again.res.statusCode).toBe(409);
    expect(again.res.body).not.toContain('member2@example.test');
  });

  it('answers forgot-password identically for a known and an unknown address', async () => {
    await register('member3@example.test');
    const known = await post('/api/v1/auth/forgot-password', { email: 'member3@example.test' });
    const unknown = await post('/api/v1/auth/forgot-password', { email: 'nobody@example.test' });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);

    const token = await latestToken('identity.password-reset', 'member3@example.test');
    expect((await post('/api/v1/auth/reset-password', { token, newPassword: 'a-new-password' })).statusCode).toBe(200);
    const login = await post('/api/v1/auth/login', { email: 'member3@example.test', password: 'a-new-password' });
    expect(login.statusCode).toBe(200);
  });

  it('changes an address only after the new one confirms, and keeps the old one working meanwhile', async () => {
    const { session } = await register('member4@example.test');
    const requested = await post('/api/v1/auth/change-email',
      { currentPassword: 'member-password', newEmail: 'member4-new@example.test' }, session);
    expect(requested.statusCode).toBe(200);
    // 還沒確認之前，舊地址仍然是這個帳號的地址。
    expect((await post('/api/v1/auth/login', { email: 'member4@example.test', password: 'member-password' })).statusCode).toBe(200);

    const token = await latestToken('identity.email-change', 'member4-new@example.test');
    expect((await post('/api/v1/auth/confirm-email-change', { token })).statusCode).toBe(200);
    expect((await post('/api/v1/auth/login', { email: 'member4@example.test', password: 'member-password' })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/login', { email: 'member4-new@example.test', password: 'member-password' })).statusCode).toBe(200);
  });

  it('refuses a change-email that only has the session, not the password', async () => {
    const { session } = await register('member5@example.test');
    const res = await post('/api/v1/auth/change-email',
      { currentPassword: 'not-the-password', newEmail: 'member5-new@example.test' }, session);
    expect(res.statusCode).toBe(401);
  });

  it('refuses to enrol a second factor on a role that login never checks', async () => {
    const { session } = await register('member-mfa@example.test');
    // member 的登入不驗第二因素（ADR 0044 只對 `mfa: 'required'` 的角色強制）。
    // 讓他註冊等於給他一個什麼都不擋、卻讓他以為受保護的第二因素。
    const res = await post('/api/v1/auth/mfa/enroll', {}, session);
    expect(res.statusCode).toBe(400);

    const rows = await runtime.database.pool.query(
      `SELECT 1 FROM platform_user_mfa m JOIN platform_users u ON u.id = m.user_id
       WHERE lower(u.email) = 'member-mfa@example.test'`);
    expect(rows.rowCount).toBe(0);
  });

  it('logs out other devices and keeps the caller signed in', async () => {
    const { session: first } = await register('member6@example.test');
    const second = (await post('/api/v1/auth/login', { email: 'member6@example.test', password: 'member-password' }))
      .cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;

    expect((await post('/api/v1/auth/revoke-other-sessions', {}, second)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: first! } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: second } })).statusCode).toBe(200);
  });

  it('rejects a session-bearing identity call that has no CSRF token', async () => {
    const { session } = await register('member7@example.test');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/resend-verification',
      cookies: { [SESSION_COOKIE]: session! }, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
