import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CART_COOKIE, CART_NOTICE_COOKIE, SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

/** 訪客識別：購物車 token 走 cookie（工單 25）。 */

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

async function sellable(sku: string) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents: 5_000 });
  await stockUp(h.runtime, product.id, 10);
  return product;
}

describe('訪客購物車的 cookie', () => {
  it('第一次操作會發一張 HttpOnly 的 token，之後帶著它就找得回同一台車', async () => {
    const product = await sellable('CART-COOKIE-1');

    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items',
      payload: { productId: product.id, quantity: 2 },
    });
    expect(added.statusCode).toBe(201);

    const cookie = added.cookies.find((c) => c.name === CART_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.value.length).toBeGreaterThan(20);

    const fetched = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [CART_COOKIE]: cookie.value } });
    expect(fetched.json().data.items).toHaveLength(1);
    expect(fetched.json().data.items[0].quantity).toBe(2);
  });

  it('沒帶 cookie 的人看到的是一台空車，而不是別人的車', async () => {
    const product = await sellable('CART-COOKIE-2');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    expect(added.cookies.find((c) => c.name === CART_COOKIE)).toBeTruthy();

    const fresh = await inject({ method: 'GET', url: '/api/v1/cart' });
    expect(fresh.json().data.items).toEqual([]);
  });

  it('已登入的會員不拿訪客 token，車綁在身分上', async () => {
    const product = await sellable('CART-COOKIE-3');
    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email: 'cart-member@example.com', password: 'a-good-password' },
    });
    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items',
      cookies: { [SESSION_COOKIE]: session },
      headers: { 'x-csrf-token': csrfTokenFor(session) },
      payload: { productId: product.id, quantity: 1 },
    });

    expect(added.statusCode).toBe(201);
    expect(added.cookies.find((c) => c.name === CART_COOKIE)).toBeUndefined();

    const fetched = await inject({
      method: 'GET', url: '/api/v1/cart', cookies: { [SESSION_COOKIE]: session },
    });
    expect(fetched.json().data.items).toHaveLength(1);
  });

  it('會員的寫入受 CSRF 保護', async () => {
    const product = await sellable('CART-COOKIE-4');
    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email: 'cart-csrf@example.com', password: 'a-good-password' },
    });
    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const res = await inject({
      method: 'POST', url: '/api/v1/cart/items',
      cookies: { [SESSION_COOKIE]: session },
      payload: { productId: product.id, quantity: 1 },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('登入時合併購物車（工單 27）', () => {
  /** 訪客先放東西，拿回那張 cart cookie。 */
  async function guestCartWith(productId: string, quantity: number): Promise<string> {
    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items', payload: { productId, quantity },
    });
    return added.cookies.find((c) => c.name === CART_COOKIE)!.value;
  }

  it('REST 註冊時併車，訪客 cookie 當場作廢', async () => {
    const product = await sellable('CART-MERGE-REG');
    const guest = await guestCartWith(product.id, 2);

    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      cookies: { [CART_COOKIE]: guest },
      payload: { email: `cart-merge-reg-${Date.now()}@example.com`, password: 'a-good-password' },
    });
    expect(registered.statusCode).toBe(201);

    const cleared = registered.cookies.find((c) => c.name === CART_COOKIE)!;
    expect(cleared.value).toBe('');

    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const mine = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [SESSION_COOKIE]: session } });
    expect(mine.json().data.items[0]).toMatchObject({ productId: product.id, quantity: 2 });

    // 併過的 token 找回來的是空車，不是原本那台。
    const orphan = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [CART_COOKIE]: guest } });
    expect(orphan.json().data.items).toEqual([]);
  });

  it('登入時併車，同一件商品取較大數量', async () => {
    const product = await sellable('CART-MERGE-LOGIN');
    const email = `cart-merge-login-${Date.now()}@example.com`;
    const password = 'a-good-password';

    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register', payload: { email, password },
    });
    const firstSession = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    await inject({
      method: 'POST', url: '/api/v1/cart/items',
      cookies: { [SESSION_COOKIE]: firstSession },
      headers: { 'x-csrf-token': csrfTokenFor(firstSession) },
      payload: { productId: product.id, quantity: 1 },
    });

    const guest = await guestCartWith(product.id, 5);
    const loggedIn = await inject({
      method: 'POST', url: '/api/v1/auth/login',
      cookies: { [CART_COOKIE]: guest },
      payload: { email, password },
    });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().data.cartNotice).toBeNull();

    const session = loggedIn.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const mine = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [SESSION_COOKIE]: session } });
    expect(mine.json().data.items).toHaveLength(1);
    expect(mine.json().data.items[0].quantity).toBe(5);
  });

  it('下架的商品在合併時移除，並且說得出被拿掉的是什麼', async () => {
    const product = await sellable('CART-MERGE-GONE');
    const guest = await guestCartWith(product.id, 1);
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: `arch-${product.id}` });

    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      cookies: { [CART_COOKIE]: guest },
      payload: { email: `cart-merge-gone-${Date.now()}@example.com`, password: 'a-good-password' },
    });

    expect(registered.json().data.cartNotice).toContain('CART-MERGE-GONE');
    expect(registered.cookies.find((c) => c.name === CART_NOTICE_COOKIE)!.value).toContain('CART-MERGE-GONE');
  });

  it('前台登入的那一刻也併車，提示顯示在下一頁而且只顯示一次', async () => {
    const product = await sellable('CART-MERGE-SSR');
    const email = `cart-merge-ssr-${Date.now()}@example.com`;
    const password = 'a-good-password';
    await inject({ method: 'POST', url: '/api/v1/customers/register', payload: { email, password } });

    const guest = await guestCartWith(product.id, 1);
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: `arch-ssr-${product.id}` });

    const loggedIn = await inject({
      method: 'POST', url: '/login',
      cookies: { [CART_COOKIE]: guest },
      payload: { email, password, next: '/' },
    });
    expect(loggedIn.statusCode).toBe(303);

    const notice = loggedIn.cookies.find((c) => c.name === CART_NOTICE_COOKIE)!.value;
    const session = loggedIn.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const home = await inject({
      method: 'GET', url: '/', cookies: { [SESSION_COOKIE]: session, [CART_NOTICE_COOKIE]: notice },
    });
    expect(home.body).toContain('CART-MERGE-SSR');
    expect(home.cookies.find((c) => c.name === CART_NOTICE_COOKIE)!.value).toBe('');

    const again = await inject({ method: 'GET', url: '/', cookies: { [SESSION_COOKIE]: session } });
    expect(again.body).not.toContain('已下架');
  });
});
