import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { CART_COOKIE, SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/**
 * 審查抓到的問題的迴歸測試（工單 26–29 的安全審查）。
 * 每一條對應一個具體的攻擊或資料遺失路徑。
 */

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

async function sellable(sku: string, overrides: Record<string, unknown> = {}) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents: 5_000, ...overrides });
  await stockUp(h.runtime, product.id, 20);
  return product;
}

const addToCart = (input: Record<string, unknown>, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

describe('冪等鍵綁身分', () => {
  it('別人的冪等鍵重放不會回傳快取的結果', async () => {
    const alice = await createCustomer(h.runtime, { email: `hard-a-${randomUUID()}@example.test` });
    const bob = await createCustomer(h.runtime, { email: `hard-b-${randomUUID()}@example.test` });
    const product = await sellable(`HARD-IDEM-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, alice);
    const cartId = (await getCart({}, alice)).id;
    const key = `cart:${cartId}`;

    const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId },
      { actor: alice, idempotencyKey: key });
    expect(order.customerEmail).toBe(alice.email);

    // Bob 猜到同一把鍵、送同一份輸入——重放發生在 handler 之前，
    // 沒有這道檢查他會直接讀到 Alice 的訂單（含 email 與品項）。
    await expect(h.runtime.commands.execute('commerce.order.checkoutCart', { cartId },
      // 回 NOT_FOUND 而不是 FORBIDDEN：後者會變成「這把鍵存不存在」的 oracle。
      { actor: bob, idempotencyKey: key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('本人重放照樣拿回同一張訂單', async () => {
    const customer = await createCustomer(h.runtime, { email: `hard-self-${randomUUID()}@example.test` });
    const product = await sellable(`HARD-SELF-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);
    const cartId = (await getCart({}, customer)).id;
    const key = `cart:${customer.id}:${cartId}`;

    const first = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId },
      { actor: customer, idempotencyKey: key });
    const second = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId },
      { actor: customer, idempotencyKey: key });

    expect(second.id).toBe(first.id);
  });
});

describe('訪客的寫入也受同源保護', () => {
  it('跨站送出的加入購物車被擋下', async () => {
    const product = await sellable('HARD-CSRF');

    const res = await inject({
      method: 'POST', url: '/cart/items',
      headers: { origin: 'https://evil.example' },
      payload: { productId: product.id, quantity: '1' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('同站送出的照常成立', async () => {
    const product = await sellable('HARD-CSRF-OK');

    const res = await inject({
      method: 'POST', url: '/cart/items',
      headers: { origin: 'http://localhost:3000' },
      payload: { productId: product.id, quantity: '1' },
    });

    expect(res.statusCode).toBe(303);
  });
});

describe('讀取不簽發訪客 token', () => {
  it('GET /cart 不發新 cookie——否則跨站的一張圖就能把購物車清空', async () => {
    const page = await inject({ method: 'GET', url: '/cart' });

    expect(page.statusCode).toBe(200);
    expect(page.cookies.find((c) => c.name === CART_COOKIE)).toBeUndefined();
  });

  it('REST 的讀取同樣不發，而且回的是空車不是錯誤', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/cart' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toEqual([]);
    expect(res.cookies.find((c) => c.name === CART_COOKIE)).toBeUndefined();
  });

  it('寫入才簽發，而且拿得回同一台車', async () => {
    const product = await sellable('HARD-ISSUE');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    const cookie = added.cookies.find((c) => c.name === CART_COOKIE)!;

    const fetched = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [CART_COOKIE]: cookie.value } });
    expect(fetched.json().data.items).toHaveLength(1);
  });
});

describe('幣別不符的商品進不了購物車', () => {
  it('加入時就被擋下，而不是進車之後隱形', async () => {
    const foreign = await sellable(`HARD-USD-${randomUUID().slice(0, 6)}`, { currency: 'USD' });
    const guestToken = randomUUID();

    await expect(addToCart({ guestToken, productId: foreign.id, quantity: 1 }, STOREFRONT_ACTOR))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('就算被塞進去，顯示與結帳的判斷也一致——不會出現看不到卻結不掉的行', async () => {
    const customer = await createCustomer(h.runtime, { email: `hard-cur-${randomUUID()}@example.test` });
    const local = await sellable(`HARD-LOCAL-${randomUUID().slice(0, 6)}`);
    const foreign = await sellable(`HARD-USD2-${randomUUID().slice(0, 6)}`, { currency: 'USD' });
    await addToCart({ productId: local.id, quantity: 1 }, customer);
    const cartId = (await getCart({}, customer)).id;
    // 繞過命令直接寫進資料表，模擬幣別在加入之後才被改掉。
    await h.runtime.database.db.execute(sql`
      INSERT INTO cart_items (id, cart_id, product_id, quantity)
      VALUES (${randomUUID()}, ${cartId}, ${foreign.id}, 1)
    `);

    const cart = await getCart({}, customer);
    expect(cart.items.map((i: any) => i.productId)).toEqual([local.id]);

    const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId },
      { actor: customer, idempotencyKey: randomUUID() });
    expect(order.lines.map((l: any) => l.productId)).toEqual([local.id]);
  });
});

describe('結完帳之後的寫入', () => {
  it('會落在一台新的車上，不會消失在已結帳的那一台裡', async () => {
    const customer = await createCustomer(h.runtime, { email: `hard-after-${randomUUID()}@example.test` });
    const product = await sellable(`HARD-AFTER-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);
    const cartId = (await getCart({}, customer)).id;
    await h.runtime.commands.execute('commerce.order.checkoutCart', { cartId },
      { actor: customer, idempotencyKey: randomUUID() });

    const after = await addToCart({ productId: product.id, quantity: 2 }, customer);

    expect(after.id).not.toBe(cartId);
    expect(after.items[0].quantity).toBe(2);
  });
});

describe('數量的累加有上限', () => {
  it('反覆加入不會讓數量無限成長', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`HARD-QTY-${randomUUID().slice(0, 6)}`);

    for (let i = 0; i < 3; i += 1) {
      await addToCart({ guestToken, productId: product.id, quantity: 999 }, STOREFRONT_ACTOR);
    }

    expect((await getCart({ guestToken }, STOREFRONT_ACTOR)).items[0].quantity).toBe(999);
  });
});

describe('購物車寫入的節流', () => {
  it('不帶 cookie 的灌車會被擋下', async () => {
    const product = await sellable('HARD-FLOOD');

    const statuses: number[] = [];
    for (let i = 0; i < 130; i += 1) {
      const res = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
      statuses.push(res.statusCode);
    }

    expect(statuses).toContain(429);
  });
});
