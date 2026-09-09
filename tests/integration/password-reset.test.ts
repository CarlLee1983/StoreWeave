import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { createHarness, type TestHarness } from './helpers';

/** 密碼重設與改密碼撤銷 session（工單 18）。 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

async function signUp(email: string, password = 'a-good-password'): Promise<string> {
  const res = await inject({
    method: 'POST', url: '/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&next=%2F`,
  });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

const requestReset = (email: string) =>
  inject({
    method: 'POST', url: '/forgot-password',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(email)}`,
  });

/** 重設信由 B06 mail 寄出，內容留在 `platform_mail_messages`。 */
async function resetMails(email?: string): Promise<{ recipients: { email: string }[]; text_body: string }[]> {
  const rows = await h.runtime.database.db.execute<{ recipients: { email: string }[]; text_body: string }>(sql`
    SELECT recipients, text_body FROM public.platform_mail_messages
    WHERE template_id = 'identity.password-reset' ORDER BY created_at
  `);
  return rows.rows.filter(row => !email || row.recipients.some(recipient => recipient.email === email));
}

async function resetTokenFor(email: string): Promise<string> {
  const mails = await resetMails(email);
  const body = mails[mails.length - 1].text_body;
  return new URL(/https?:\/\/\S+/.exec(body)![0]).searchParams.get('token')!;
}

const login = (email: string, password: string) =>
  inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

describe('請求重設密碼', () => {
  it('回應中性訊息，不透露 email 是否存在', async () => {
    await signUp('reset1@example.com');

    const existing = await requestReset('reset1@example.com');
    const missing = await requestReset('nobody-here@example.com');

    expect(existing.statusCode).toBe(missing.statusCode);
    expect(existing.body).toContain('若這個電子郵件存在');
    expect(missing.body).toContain('若這個電子郵件存在');
  });

  it('信由平台自己的 mail 能力寄出，樣板與收件者正確', async () => {
    await signUp('reset2@example.com');
    await requestReset('reset2@example.com');

    const sent = await resetMails('reset2@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].text_body).toContain('/reset-password?token=');
  });

  it('不存在的 email 不會寄出任何東西', async () => {
    const before = (await resetMails()).length;
    await requestReset('nobody-at-all@example.com');
    expect((await resetMails()).length).toBe(before);
  });

  it('資料庫裡沒有任何可以重建連結的材料', async () => {
    await signUp('reset3@example.com');
    await requestReset('reset3@example.com');
    const token = await resetTokenFor('reset3@example.com');

    // 簽章值只出現在信裡；token 表存的是 id、用途與到期，沒有秘密。
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_identity_tokens
      WHERE id::text = ${token} OR coalesce(data, '') = ${token}
    `);
    expect(rows.rows[0].count).toBe('0');
  });
});

describe('使用重設連結', () => {
  it('設定新密碼後可以用新密碼登入，舊密碼失效', async () => {
    await signUp('reset4@example.com', 'old-password-1');
    await requestReset('reset4@example.com');
    const token = await resetTokenFor('reset4@example.com');

    const done = await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=brand-new-password`,
    });
    expect(done.statusCode).toBe(303);

    expect((await login('reset4@example.com', 'brand-new-password')).statusCode).toBe(200);
    expect((await login('reset4@example.com', 'old-password-1')).statusCode).toBe(401);
  });

  it('同一個 token 只能用一次', async () => {
    await signUp('reset5@example.com');
    await requestReset('reset5@example.com');
    const token = await resetTokenFor('reset5@example.com');

    const first = await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=first-new-password`,
    });
    expect(first.statusCode).toBe(303);

    const second = await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=second-new-password`,
    });
    expect(second.statusCode).toBe(400);
    expect((await login('reset5@example.com', 'second-new-password')).statusCode).toBe(401);
  });

  it('過期的 token 不能用', async () => {
    await signUp('reset6@example.com');
    await requestReset('reset6@example.com');
    const token = await resetTokenFor('reset6@example.com');
    await h.runtime.database.db.execute(sql`UPDATE platform_identity_tokens SET expires_at = now() - interval '1 minute'`);

    const res = await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=too-late-password`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('太短的新密碼被擋下來', async () => {
    await signUp('reset7@example.com');
    await requestReset('reset7@example.com');
    const token = await resetTokenFor('reset7@example.com');

    const res = await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=short`,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('改密碼會踢掉其他裝置', () => {
  it('完成重設後，原本的 session 全部失效', async () => {
    const session = await signUp('reset8@example.com', 'old-password-1');
    expect((await inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: session } })).statusCode).toBe(200);

    await requestReset('reset8@example.com');
    const token = await resetTokenFor('reset8@example.com');
    await inject({
      method: 'POST', url: '/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}&password=another-new-password`,
    });

    const me = await inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: session } });
    expect(me.statusCode).toBe(401);
  });

  it('主動改密碼會讓其他裝置的登入失效，自己這台還在', async () => {
    const first = await signUp('reset9@example.com', 'old-password-1');
    const second = (await login('reset9@example.com', 'old-password-1')).cookies
      .find((c) => c.name === SESSION_COOKIE)!.value;

    const changed = await inject({
      method: 'POST', url: '/api/v1/auth/change-password',
      cookies: { [SESSION_COOKIE]: second },
      headers: { 'x-csrf-token': (await import('@storeweave/identity')).csrfTokenFor(second) },
      payload: { currentPassword: 'old-password-1', newPassword: 'changed-password-1' },
    });
    expect(changed.statusCode).toBe(200);

    expect((await inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: first } })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: second } })).statusCode).toBe(200);
  });

  it('現有密碼填錯就不改', async () => {
    const session = await signUp('reset10@example.com', 'old-password-1');

    const res = await inject({
      method: 'POST', url: '/api/v1/auth/change-password',
      cookies: { [SESSION_COOKIE]: session },
      headers: { 'x-csrf-token': (await import('@storeweave/identity')).csrfTokenFor(session) },
      payload: { currentPassword: 'wrong-password', newPassword: 'changed-password-1' },
    });

    expect(res.statusCode).toBe(401);
    expect((await login('reset10@example.com', 'old-password-1')).statusCode).toBe(200);
  });
});
