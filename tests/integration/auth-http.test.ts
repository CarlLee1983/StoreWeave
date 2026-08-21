import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, type TestHarness } from './helpers';

const ADMIN_TOKEN = 'test-admin-token-abcdefghijklmnop';

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  (h.runtime.config.auth.tokens as unknown[]).push({ name: 'admin', role: 'admin', secretRef: 'ADMIN_TOKEN' });
  (h.runtime as { secrets: any }).secrets = {
    get: (n: string) => ({ ADMIN_TOKEN, DEMO_ERP_API_KEY: 'test-key' } as Record<string, string>)[n],
    has: (n: string) => Boolean(({ ADMIN_TOKEN, DEMO_ERP_API_KEY: 'k' } as Record<string, string>)[n]),
    listNames: () => [],
  };
  app = await createServer({
    runtime: h.runtime,
    theme: defaultTheme,
    release: { version: 'test', configPath: '<test>' },
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

function inject(options: Parameters<NestFastifyApplication['inject']>[0]) {
  return app.inject(options);
}

async function createOperator(email: string, password: string) {
  return h.runtime.commands.execute(
    'platform.identity.createUser',
    { email, password, displayName: '測試操作者', role: 'admin' },
    { actor: ADMIN_ACTOR, idempotencyKey: `create-operator:${email}` },
  );
}

function cookieValue(res: Awaited<ReturnType<typeof inject>>, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

describe('登入 / 登出 / session cookie', () => {
  it('正確帳密登入回 200，發出 HttpOnly session cookie，body 不含 token', async () => {
    await createOperator('operator1@example.com', 'correct horse battery staple');

    const res = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator1@example.com', password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.email).toBe('operator1@example.com');
    expect(JSON.stringify(body)).not.toMatch(/token/i);

    const sessionCookie = res.cookies.find((c) => c.name === 'commerce_session');
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);

    const csrfCookie = res.cookies.find((c) => c.name === 'commerce_csrf');
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie?.httpOnly).toBeFalsy();
  });

  it('錯誤密碼回 401', async () => {
    await createOperator('operator2@example.com', 'correct horse battery staple');

    const res = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator2@example.com', password: 'wrong password entirely' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('帶著 session cookie 可以呼叫 GET /api/v1/products', async () => {
    await createOperator('operator3@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator3@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;

    const res = await inject({
      method: 'GET', url: '/api/v1/products',
      cookies: { commerce_session: sessionToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('帶 session cookie 但缺 x-csrf-token 的 POST 被擋 403', async () => {
    await createOperator('operator4@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator4@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;

    const res = await inject({
      method: 'POST', url: '/api/v1/products',
      cookies: { commerce_session: sessionToken },
      headers: { 'idempotency-key': 'csrf-missing-1' },
      payload: { sku: 'CSRF-1', name: '缺 CSRF', priceCents: 1000, currency: 'TWD', status: 'active' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it('帶 session cookie 且 CSRF token 正確的 POST 可以通過', async () => {
    await createOperator('operator5@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator5@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;
    const csrfToken = cookieValue(login, 'commerce_csrf')!;

    const res = await inject({
      method: 'POST', url: '/api/v1/products',
      cookies: { commerce_session: sessionToken, commerce_csrf: csrfToken },
      headers: { 'idempotency-key': 'csrf-ok-1', 'x-csrf-token': csrfToken },
      payload: { sku: 'CSRF-2', name: '正確 CSRF', priceCents: 1000, currency: 'TWD', status: 'active' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('攻擊者自選的 CSRF cookie 與 header 配對無效（雙提交必須綁定 session）', async () => {
    await createOperator('operator9@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator9@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;

    // cookie tossing：攻擊者同時決定 cookie 與 header，兩邊相等但不是由 session 推導出來的
    const forged = 'attacker-chosen-value';
    const res = await inject({
      method: 'POST', url: '/api/v1/products',
      cookies: { commerce_session: sessionToken, commerce_csrf: forged },
      headers: { 'idempotency-key': 'csrf-forged-1', 'x-csrf-token': forged },
      payload: { sku: 'CSRF-3', name: '偽造 CSRF', priceCents: 1000, currency: 'TWD', status: 'active' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('用 bearer token 的 POST 不需要 CSRF token', async () => {
    const res = await inject({
      method: 'POST', url: '/api/v1/products',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'idempotency-key': 'bearer-no-csrf-1' },
      payload: { sku: 'BEARER-1', name: 'Bearer 不需 CSRF', priceCents: 1000, currency: 'TWD', status: 'active' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('logout 之後原本的 cookie 不能再用', async () => {
    await createOperator('operator6@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator6@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;
    const csrfToken = cookieValue(login, 'commerce_csrf')!;

    const logout = await inject({
      method: 'POST', url: '/api/v1/auth/logout',
      cookies: { commerce_session: sessionToken, commerce_csrf: csrfToken },
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(logout.statusCode).toBe(200);

    const res = await inject({
      method: 'GET', url: '/api/v1/products',
      cookies: { commerce_session: sessionToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('連續失敗的登入會被節流（擋掉線上爆破與 scrypt 放大攻擊）', async () => {
    const email = 'bruteforce@example.com';
    await createOperator(email, 'correct horse battery staple');

    // 節流以 IP 為鍵，因此每個節流測試都用自己的來源 IP，免得吃掉別的測試的額度
    const attempt = () => inject({
      method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.0.0.1',
      payload: { email, password: 'wrong-guess' },
    });

    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) codes.push((await attempt()).statusCode);

    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // 節流後正確密碼也一樣被擋，否則就不是節流
    const blocked = await inject({
      method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.0.0.1',
      payload: { email, password: 'correct horse battery staple' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('百分比編碼的登入路徑一樣受節流（否則節流形同虛設）', async () => {
    const email = 'encoded@example.com';
    await createOperator(email, 'correct horse battery staple');

    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      // /api/v1/auth/%6cogin 會被 Fastify 解碼後打到同一個 handler，
      // 但用 request.url 寫的條件看不出來
      const res = await inject({
        method: 'POST', url: '/api/v1/auth/%6cogin', remoteAddress: '10.0.0.2',
        payload: { email, password: 'wrong-guess' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });

  it('每次換一個 email 也會被 IP 層節流（scrypt 放大攻擊面）', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 62; i += 1) {
      const res = await inject({
        method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.0.0.3',
        payload: { email: `random-${i}@example.com`, password: 'wrong-guess' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });

  it('GET /api/v1/auth/me 未登入回 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/auth/me 帶 session cookie 回目前使用者', async () => {
    await createOperator('operator7@example.com', 'correct horse battery staple');
    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator7@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;

    const res = await inject({
      method: 'GET', url: '/api/v1/auth/me',
      cookies: { commerce_session: sessionToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe('operator7@example.com');
  });
});
