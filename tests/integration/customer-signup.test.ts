import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { csrfTokenFor } from '@storeweave/identity';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, defaultThemeRelease, stockUp, type TestHarness } from './helpers';

/** 顧客註冊、登入與登出（工單 14）。 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  app = await createServer({
    runtime: h.runtime,
    theme: defaultTheme,
    release: defaultThemeRelease(),
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

const register = (payload: Record<string, unknown>) =>
  inject({ method: 'POST', url: '/api/v1/customers/register', payload });

const login = (email: string, password: string) =>
  inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

function cookie(res: Awaited<ReturnType<typeof inject>>, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

describe('顧客註冊', () => {
  it('訪客可以註冊，而且註冊完就已經登入', async () => {
    const res = await register({ email: 'buyer1@example.com', password: 'a-good-password' });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.email).toBe('buyer1@example.com');
    expect(cookie(res, SESSION_COOKIE)).toBeTruthy();
    // 密碼與雜湊都不該出現在回應裡
    expect(JSON.stringify(res.json())).not.toContain('a-good-password');
    expect(JSON.stringify(res.json())).not.toMatch(/scrypt|\$/);
  });

  it('重複的 email 被拒絕，且不留下半個帳號', async () => {
    await register({ email: 'buyer2@example.com', password: 'a-good-password' });
    const again = await register({ email: 'buyer2@example.com', password: 'another-password' });

    expect(again.statusCode).toBe(409);

    const accounts = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_users WHERE lower(email) = 'buyer2@example.com'
    `);
    expect(accounts.rows[0].count).toBe('1');
  });

  it('太短的密碼被擋下來', async () => {
    const res = await register({ email: 'buyer3@example.com', password: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('顧客的領域資料在 commerce 模組，平台的帳號表不含顧客欄位', async () => {
    const res = await register({ email: 'buyer4@example.com', password: 'a-good-password', displayName: '小明' });
    const customerId = res.json().data.id;

    const customer = await h.runtime.database.db.execute<{ display_name: string; account_id: string }>(sql`
      SELECT display_name, account_id FROM customer_customers WHERE id = ${customerId}
    `);
    expect(customer.rows[0].display_name).toBe('小明');

    const columns = await h.runtime.database.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_users'
    `);
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('birthday');
    expect(names).not.toContain('phone');

    // 帳號與顧客資料以 account_id 相連
    const account = await h.runtime.database.db.execute<{ role: string }>(sql`
      SELECT role FROM platform_users WHERE id = ${customer.rows[0].account_id}
    `);
    expect(account.rows[0].role).toBe('customer');
  });

  it('註冊留下稽核紀錄，但 payload 不含 email', async () => {
    const res = await register({ email: 'buyer5@example.com', password: 'a-good-password' });
    const customerId = res.json().data.id;

    const audit = await h.runtime.database.db.execute<{ action: string; payload: unknown }>(sql`
      SELECT action, payload FROM platform_audit_log WHERE resource_type = 'customer' AND resource_id = ${customerId}
    `);
    expect(audit.rows[0].action).toBe('customer.registered');
    expect(JSON.stringify(audit.rows[0].payload ?? {})).not.toContain('buyer5@example.com');
  });
});

describe('顧客登入與登出', () => {
  it('登入後的身分是顧客型別，稽核紀錄分得出來', async () => {
    await register({ email: 'buyer6@example.com', password: 'a-good-password' });
    const session = cookie(await login('buyer6@example.com', 'a-good-password'), SESSION_COOKIE)!;

    const product = await createProduct(h.runtime, { sku: 'CUSTOMER-ORDER', name: '顧客下單' });
    await stockUp(h.runtime, product.id, 2);

    const created = await inject({
      method: 'POST', url: '/api/v1/orders',
      cookies: { [SESSION_COOKIE]: session },
      headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': 'customer-order-1' },
      // 不送 customerEmail：下單者由身分決定（工單 21），送了會被 strict 擋下
      payload: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.statusCode).toBe(201);
    // 訂單上的 email 來自帳號，不是呼叫端說了算
    expect(created.json().data.customerEmail).toBe('buyer6@example.com');

    const audit = await h.runtime.database.db.execute<{ actor_type: string; actor_id: string }>(sql`
      SELECT actor_type, actor_id FROM platform_audit_log
      WHERE resource_type = 'order' AND resource_id = ${created.json().data.id}
    `);
    expect(audit.rows[0].actor_type).toBe('customer');
    expect(audit.rows[0].actor_id).toMatch(/^user:/);
  });

  it('顧客的 session 活得比後台操作者久', async () => {
    await register({ email: 'buyer7@example.com', password: 'a-good-password' });
    const customerSession = await login('buyer7@example.com', 'a-good-password');

    await h.runtime.commands.execute('platform.identity.createUser',
      { email: 'operator-ttl@example.com', password: 'operator-password-12', displayName: '店員', role: 'staff' },
      { actor: ADMIN_ACTOR, idempotencyKey: 'operator-ttl' });
    const operatorSession = await login('operator-ttl@example.com', 'operator-password-12');

    const maxAge = (res: Awaited<ReturnType<typeof inject>>) =>
      res.cookies.find((c) => c.name === SESSION_COOKIE)!.maxAge!;

    expect(maxAge(customerSession)).toBeGreaterThan(maxAge(operatorSession));
    expect(maxAge(customerSession)).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(maxAge(operatorSession)).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it('登出之後 session 不能再用', async () => {
    await register({ email: 'buyer8@example.com', password: 'a-good-password' });
    const session = cookie(await login('buyer8@example.com', 'a-good-password'), SESSION_COOKIE)!;

    // 登出是狀態變更，一樣要過 CSRF：強制登出是 CSRF 的標準目標
    const out = await inject({
      method: 'POST', url: '/api/v1/auth/logout',
      cookies: { [SESSION_COOKIE]: session },
      headers: { 'x-csrf-token': csrfTokenFor(session) },
    });
    expect(out.statusCode).toBe(200);

    const me = await inject({ method: 'GET', url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: session } });
    expect(me.statusCode).toBe(401);
  });
});
