import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

let ADMIN_TOKEN: string;

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  const issued = await h.runtime.database.transaction(tx => h.runtime.apiTokens.issue(tx, {
    name: 'admin', role: 'admin', ttlMs: 60 * 60_000,
  }));
  ADMIN_TOKEN = issued.secret;
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

  it('每次換一個 email 也在第 61 次被 IP 層節流（scrypt 放大攻擊面）', async () => {
    for (let i = 0; i < 60; i += 1) {
      const response = await inject({
        method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.0.0.3',
        payload: { email: `random-${i}@example.com`, password: 123 },
      });
      expect(response.statusCode).toBe(400);
    }
    const limited = await inject({
      method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.0.0.3',
      payload: { email: 'random-61@example.com', password: 123 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('charges the IP bucket before the exceeded account bucket', async () => {
    const remoteAddress = '10.0.0.4';
    const email = 'ip-before-account@example.com';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await inject({
        method: 'POST', url: '/api/v1/auth/login', remoteAddress,
        payload: { email, password: 123 },
      });
      expect(response.statusCode).toBe(attempt < 10 ? 400 : 429);
    }
    const limited = await inject({
      method: 'POST', url: '/api/v1/auth/login', remoteAddress,
      payload: { email: 'new-after-account@example.com', password: 123 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('GET /api/v1/auth/me 未登入回 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('auth me 與 change-password 只接受 session cookie', async () => {
    await createOperator('operator7@example.com', 'correct horse battery staple');
    for (const options of [
      { method: 'GET' as const, url: '/api/v1/auth/me' },
      { method: 'POST' as const, url: '/api/v1/auth/change-password', payload: {
        currentPassword: 'correct horse battery staple', newPassword: 'new correct horse battery staple',
      } },
    ]) {
      const response = await inject({ ...options, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.message).toBe('No active session');
    }

    const login = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'operator7@example.com', password: 'correct horse battery staple' },
    });
    const sessionToken = cookieValue(login, 'commerce_session')!;
    const csrfToken = cookieValue(login, 'commerce_csrf')!;

    const res = await inject({
      method: 'GET', url: '/api/v1/auth/me',
      cookies: { commerce_session: sessionToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe('operator7@example.com');

    const changed = await inject({
      method: 'POST', url: '/api/v1/auth/change-password',
      cookies: { commerce_session: sessionToken, commerce_csrf: csrfToken },
      headers: { 'x-csrf-token': csrfToken },
      payload: { currentPassword: 'correct horse battery staple', newPassword: 'new correct horse battery staple' },
    });
    expect(changed.statusCode).toBe(200);
  });
});

describe('三段式守衛在 HTTP 上的行為（工單 11）', () => {
  async function loginAs(email: string, password = 'correct horse battery staple') {
    await createOperator(email, password);
    const res = await inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    return cookieValue(res, SESSION_COOKIE)!;
  }

  it('匿名訪客照樣逛得了商店首頁與商品頁', async () => {
    const home = await inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
  });

  it('帶著有效 session 逛前台不會被擋，頁面照常呈現', async () => {
    const session = await loginAs('guard-session@example.com');
    const home = await inject({ method: 'GET', url: '/', cookies: { [SESSION_COOKIE]: session } });
    expect(home.statusCode).toBe(200);
  });

  it('過期或偽造的 cookie 不會讓前台壞掉，退回訪客', async () => {
    const home = await inject({ method: 'GET', url: '/', cookies: { [SESSION_COOKIE]: 'not-a-real-session' } });
    expect(home.statusCode).toBe(200);
  });

  it('但非公開端點的壞 cookie 仍然是 401', async () => {
    const res = await inject({
      method: 'GET', url: '/api/v1/products',
      cookies: { [SESSION_COOKIE]: 'not-a-real-session' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('登入是強制匿名的：帶著舊 session 又沒有 CSRF token 也能重新登入', async () => {
    const session = await loginAs('guard-relogin@example.com');

    const again = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      cookies: { [SESSION_COOKIE]: session },
      payload: { email: 'guard-relogin@example.com', password: 'correct horse battery staple' },
    });

    expect(again.statusCode).toBe(200);
    expect(cookieValue(again, SESSION_COOKIE)).toBeTruthy();
  });

  it('探針端點不解析身分，帶壞 cookie 也照樣回報', async () => {
    const live = await inject({ method: 'GET', url: '/health/live', cookies: { [SESSION_COOKIE]: 'garbage' } });
    expect(live.statusCode).toBe(200);
  });

  it('未登入結帳被導去登入頁（工單 21 之後結帳需要顧客身分）', async () => {
    const product = await createProduct(h.runtime, { sku: 'GUARD-CHECKOUT', name: '守衛測試' });
    await stockUp(h.runtime, product.id, 3);

    const res = await inject({
      method: 'POST', url: '/checkout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `productId=${product.id}&quantity=1`,
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/login/);
  });
});

describe('CSRF 與跨站送出（真實表單路徑）', () => {
  async function memberSession(email: string): Promise<string> {
    const res = await inject({
      method: 'POST', url: '/register',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(email)}&password=a-good-password&next=%2F`,
    });
    return cookieValue(res, SESSION_COOKIE)!;
  }

  it('缺 _csrf 的結帳被擋下來', async () => {
    const session = await memberSession('csrf-checkout@example.com');
    const product = await createProduct(h.runtime, { sku: 'CSRF-CHECKOUT', name: 'CSRF' });
    await stockUp(h.runtime, product.id, 2);

    const res = await inject({
      method: 'POST', url: '/checkout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { [SESSION_COOKIE]: session },
      payload: `productId=${product.id}&quantity=1`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('缺 _csrf 的個人資料儲存也被擋下來', async () => {
    const session = await memberSession('csrf-profile@example.com');

    const res = await inject({
      method: 'POST', url: '/account/profile',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { [SESSION_COOKIE]: session },
      payload: 'displayName=%E5%B0%8F%E6%98%8E',
    });

    expect(res.statusCode).toBe(403);
  });

  it('別的網站送過來的登入被擋下來（登入 CSRF / session 植入）', async () => {
    const res = await inject({
      method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      payload: 'email=someone%40example.com&password=a-good-password',
    });

    expect(res.statusCode).toBe(403);
  });

  it('同源送出的登入照常運作', async () => {
    await memberSession('same-origin@example.com');

    const res = await inject({
      method: 'POST', url: '/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: h.runtime.config.http.publicUrl,
      },
      payload: 'email=same-origin%40example.com&password=a-good-password&next=%2F',
    });

    expect(res.statusCode).toBe(303);
  });

  it('登入後的轉址只接受站內路徑', async () => {
    await memberSession('open-redirect@example.com');

    for (const next of ['/\\evil.example', '//evil.example', 'https://evil.example', '/\tevil.example']) {
      const res = await inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=open-redirect%40example.com&password=a-good-password&next=${encodeURIComponent(next)}`,
      });
      expect(res.statusCode).toBe(303);
      // 重點是「不會離站」：站內相對路徑（即使長得像網域）是安全的
      const location = res.headers.location as string;
      expect(location.startsWith('/')).toBe(true);
      expect(location.startsWith('//')).toBe(false);
      expect(location).not.toContain('\\');
      expect(new URL(location, 'https://shop.internal').origin).toBe('https://shop.internal');
    }
  });
});

describe('前台表單路由的節流', () => {
  it('連續打前台的 /login 一樣會被擋掉', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      const res = await inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=throttle-front%40example.com&password=wrong-password',
      });
      if (res.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('忘記密碼也受節流，否則就是免費的寄信轟炸器', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      const res = await inject({
        method: 'POST', url: '/forgot-password',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=throttle-forgot%40example.com',
      });
      if (res.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
