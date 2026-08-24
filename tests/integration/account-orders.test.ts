import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { createHarness, createProduct, stockUp, storefrontCheckoutForm, type TestHarness } from './helpers';

/** 會員中心：我的訂單（工單 20）。 */

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

/** 註冊一位會員並回傳它的 session cookie。 */
async function signUp(email: string): Promise<string> {
  const res = await inject({
    method: 'POST', url: '/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `email=${encodeURIComponent(email)}&password=a-good-password&next=%2F`,
  });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

async function buy(session: string, sku: string, quantity = 1): Promise<string> {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents: 12_000 });
  await stockUp(h.runtime, product.id, 10);

  const page = await inject({ method: 'GET', url: `/p/${product.id}`, cookies: { [SESSION_COOKIE]: session } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
  const form = (body: string) => ({
    headers: { 'content-type': 'application/x-www-form-urlencoded' as const },
    cookies: { [SESSION_COOKIE]: session },
    payload: `${body}&_csrf=${encodeURIComponent(csrf)}`,
  });

  // 前台一律經購物車下單（工單 29）。
  await inject({ method: 'POST', url: '/cart/items', ...form(`productId=${product.id}&quantity=${quantity}`) });
  const confirm = await inject({ method: 'GET', url: '/checkout', cookies: { [SESSION_COOKIE]: session } });
  const cartId = /name="cartId" value="([^"]+)"/.exec(confirm.body)![1];

  const res = await inject({ method: 'POST', url: '/checkout', ...form(storefrontCheckoutForm(h, cartId)) });
  return (res.headers.location as string).replace('/orders/', '');
}

describe('我的訂單', () => {
  it('未登入會被引導去登入，而且記得原本要去哪裡', async () => {
    const res = await inject({ method: 'GET', url: '/account/orders' });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent('/account/orders')}`);
  });

  it('列出自己所有的訂單，不含別人的', async () => {
    const alice = await signUp('alice-orders@example.com');
    const bob = await signUp('bob-orders@example.com');
    const aliceOrder = await buy(alice, 'ACCOUNT-ALICE');
    const bobOrder = await buy(bob, 'ACCOUNT-BOB');

    const page = await inject({ method: 'GET', url: '/account/orders', cookies: { [SESSION_COOKIE]: alice } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(aliceOrder);
    expect(page.body).not.toContain(bobOrder);
  });

  it('點得進自己的訂單細節，看得到商品行、金額與狀態', async () => {
    const session = await signUp('detail@example.com');
    const number = await buy(session, 'ACCOUNT-DETAIL', 2);

    const page = await inject({ method: 'GET', url: `/orders/${number}`, cookies: { [SESSION_COOKIE]: session } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('ACCOUNT-DETAIL');
    expect(page.body).toContain(number);
    expect(page.body).toMatch(/payment_processing|pending/);
  });

  it('以他人的訂單號直接存取被拒', async () => {
    const alice = await signUp('alice-scope@example.com');
    const bob = await signUp('bob-scope@example.com');
    const aliceOrder = await buy(alice, 'ACCOUNT-SCOPE');

    const page = await inject({ method: 'GET', url: `/orders/${aliceOrder}`, cookies: { [SESSION_COOKIE]: bob } });

    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain('alice-scope@example.com');
  });

  it('訂單很多時分頁，且看得到下一頁的入口', async () => {
    const session = await signUp('paging@example.com');
    for (let i = 0; i < 3; i += 1) await buy(session, `ACCOUNT-PAGE-${i}`);

    const first = await inject({ method: 'GET', url: '/account/orders?limit=2', cookies: { [SESSION_COOKIE]: session } });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('/account/orders?limit=2&offset=2');

    const second = await inject({ method: 'GET', url: '/account/orders?limit=2&offset=2', cookies: { [SESSION_COOKIE]: session } });
    expect(second.statusCode).toBe(200);
  });
});

describe('個人資料頁', () => {
  it('未登入被導去登入', async () => {
    const res = await inject({ method: 'GET', url: '/account/profile' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent('/account/profile')}`);
  });

  it('存得起來，而且重新載入還在', async () => {
    const session = await signUp('profile-page@example.com');
    const page = await inject({ method: 'GET', url: '/account/profile', cookies: { [SESSION_COOKIE]: session } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];

    const saved = await inject({
      method: 'POST', url: '/account/profile',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { [SESSION_COOKIE]: session },
      payload: `displayName=${encodeURIComponent('小美')}&phone=0911222333&birthday=1992-03-04`
        + `&recipient=${encodeURIComponent('小美')}&addressPhone=0911222333&postcode=100&city=${encodeURIComponent('台北市')}`
        + `&line1=${encodeURIComponent('中正區重慶南路一段 1 號')}&line2=&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('已儲存');

    const again = await inject({ method: 'GET', url: '/account/profile', cookies: { [SESSION_COOKIE]: session } });
    expect(again.body).toContain('小美');
    expect(again.body).toContain('中正區重慶南路一段 1 號');
    // 生日設定後不能自己改：欄位變成唯讀
    expect(again.body).toContain('生日設定後不能自行修改');
  });
});
