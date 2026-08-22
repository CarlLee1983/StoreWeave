import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CART_COOKIE, SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { createHarness, createProduct, stockUp, type TestHarness } from './helpers';

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
