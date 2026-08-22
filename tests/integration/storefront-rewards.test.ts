import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

/** 前台購物金與等級呈現（工單 49）。 */

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

/** 註冊一位顧客並回傳 cookie 與 customerId。 */
async function signIn(tag: string) {
  const email = `sfr-${tag}-${randomUUID().slice(0, 8)}@example.com`;
  const registered = await inject({
    method: 'POST', url: '/api/v1/customers/register', payload: { email, password: 'a-good-password' },
  });
  const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const customerId = (await h.runtime.database.db.execute<{ id: string }>(sql`
    SELECT c.id FROM customer_customers c
    JOIN platform_users u ON u.id = c.account_id
    WHERE u.email = ${email}
  `)).rows[0].id;
  return { cookies: { [SESSION_COOKIE]: session }, customerId };
}

const grant = (customerId: string, amountCents: number, reason = '測試補償') =>
  h.runtime.commands.execute('commerce.loyalty.adjustRewards', { customerId, amountCents, reason },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const grantPoints = (customerId: string, points: number) =>
  h.runtime.commands.execute('commerce.loyalty.adjustTierPoints', { customerId, points, reason: '測試' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

describe('會員中心的購物金', () => {
  it('未登入會被帶去登入', async () => {
    const res = await inject({ method: 'GET', url: '/account/rewards' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent('/account/rewards')}`);
  });

  it('顯示可用餘額、未生效金額與最近的到期日', async () => {
    const me = await signIn('balance');
    await grant(me.customerId, 12_300);
    await h.runtime.database.db.execute(sql`
      UPDATE loyalty_reward_entries SET expires_at = now() + interval '20 days' WHERE customer_id = ${me.customerId}
    `);
    // 再給一筆還沒生效的。
    await h.runtime.database.db.execute(sql`
      INSERT INTO loyalty_reward_entries (id, customer_id, amount_cents, source, effective_at, expires_at)
      VALUES (${randomUUID()}, ${me.customerId}, 4_500, 'order-accrual', now() + interval '7 days', NULL)
    `);

    const page = await inject({ method: 'GET', url: '/account/rewards', cookies: me.cookies });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('可用購物金');
    expect(page.body).toMatch(/123/);
    expect(page.body).toContain('尚未生效');
    expect(page.body).toContain('到期');
  });

  it('每一筆分錄看得到金額、說明與時間，來源翻成人看得懂的說法', async () => {
    const me = await signIn('entries');
    await grant(me.customerId, 5_000, '客訴補償');
    await h.runtime.database.db.execute(sql`
      INSERT INTO loyalty_reward_entries (id, customer_id, amount_cents, source, effective_at)
      VALUES (${randomUUID()}, ${me.customerId}, 800, 'order-accrual', now())
    `);

    const page = await inject({ method: 'GET', url: '/account/rewards', cookies: me.cookies });

    expect(page.body).toContain('客訴補償');
    expect(page.body).toContain('購物回饋');
    // 帳本的來源代碼不該外洩到畫面上。
    expect(page.body).not.toContain('order-accrual');
  });

  it('顯示目前等級與距離下一級還差多少', async () => {
    const me = await signIn('tier');
    await grantPoints(me.customerId, 4_000);

    const page = await inject({ method: 'GET', url: '/account/rewards', cookies: me.cookies });

    expect(page.body).toContain('銀卡');
    expect(page.body).toContain('等級積分 4000');
    expect(page.body).toMatch(/再累積 6000 點升到「金卡」/);
  });

  it('說明滾動期間的算法與重算頻率——降級時要解釋得了為什麼', async () => {
    const me = await signIn('window');

    const page = await inject({ method: 'GET', url: '/account/rewards', cookies: me.cookies });

    expect(page.body).toMatch(/最近 12 個月/);
    expect(page.body).toContain('每天重新計算一次');
    expect(page.body).toContain('等級積分不能折抵金額');
  });

  it('沒有任何紀錄的人看到的是空狀態，不是壞掉的頁面', async () => {
    const me = await signIn('empty');

    const page = await inject({ method: 'GET', url: '/account/rewards', cookies: me.cookies });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('還沒有任何購物金紀錄');
    expect(page.body).toContain('一般會員');
  });
});

describe('購物車頁的折抵', () => {
  it('會員在購物車頁看得到折抵欄位，送出後金額改變', async () => {
    const me = await signIn('redeem');
    await grant(me.customerId, 6_000);
    const product = await createProduct(h.runtime, { sku: `SFR-${randomUUID().slice(0, 8)}`, name: 'sfr', priceCents: 20_000 });
    await stockUp(h.runtime, product.id, 10);

    const page0 = await inject({ method: 'GET', url: '/p/' + product.id, cookies: me.cookies });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page0.body)![1];
    const form = (body: string) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' as const },
      cookies: me.cookies,
      payload: `${body}&_csrf=${encodeURIComponent(csrf)}`,
    });

    await inject({ method: 'POST', url: '/cart/items', ...form(`productId=${product.id}&quantity=1`) });

    const cart = await inject({ method: 'GET', url: '/cart', cookies: me.cookies });
    expect(cart.body).toContain('可用購物金');
    expect(cart.body).toContain('action="/cart/rewards"');

    // 折 50 元。
    const applied = await inject({ method: 'POST', url: '/cart/rewards', ...form('amount=50') });
    expect(applied.statusCode).toBe(303);

    const after = await inject({ method: 'GET', url: '/cart', cookies: me.cookies });
    expect(after.body).toMatch(/150/);
  });

  it('訪客沒有折抵欄位——他沒有帳本', async () => {
    const product = await createProduct(h.runtime, { sku: `SFRG-${randomUUID().slice(0, 8)}`, name: 'sfrg', priceCents: 20_000 });
    await stockUp(h.runtime, product.id, 10);
    const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: '1' } });
    const cookies = { commerce_cart: added.cookies.find((c) => c.name === 'commerce_cart')!.value };

    const cart = await inject({ method: 'GET', url: '/cart', cookies });
    expect(cart.body).not.toContain('action="/cart/rewards"');
  });
});
