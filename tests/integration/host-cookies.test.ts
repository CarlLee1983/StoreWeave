import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

/**
 * https 部署上，所有 cookie 都必須帶 `__Host-` 前綴——子網域因此蓋不掉它們。
 * 本機 http 開發拿不到 Secure，那條路徑由 `tests/unit/cookie-names.test.ts` 蓋。
 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  // 名字是每次請求現算的，因此改設定就足以模擬 https 部署，不必真的架 TLS。
  h.runtime.config.http.publicUrl = 'https://shop.example.test';
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

async function register(email: string, password = 'a-good-password') {
  return inject({
    method: 'POST', url: '/api/v1/customers/register',
    payload: { email, password, displayName: '前綴測試' },
  });
}

describe('__Host- 前綴', () => {
  it('註冊發出的 session 與 CSRF cookie 都帶前綴、Secure、Path=/，且沒有 Domain', async () => {
    const res = await register(`host-${randomUUID()}@example.test`);
    expect(res.statusCode).toBe(201);

    const names = res.cookies.map((c) => c.name);
    expect(names).toContain('__Host-commerce_session');
    expect(names).toContain('__Host-commerce_csrf');
    expect(names).not.toContain('commerce_session');

    for (const name of ['__Host-commerce_session', '__Host-commerce_csrf']) {
      const cookie = res.cookies.find((c) => c.name === name)! as Record<string, unknown>;
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe('/');
      expect(cookie.domain).toBeUndefined();
    }
  });

  it('帶前綴的 session 認得出身分，沒有前綴的同名 cookie 一律不認', async () => {
    const registered = await register(`host-auth-${randomUUID()}@example.test`);
    const session = registered.cookies.find((c) => c.name === '__Host-commerce_session')!.value;

    const withPrefix = await inject({
      method: 'GET', url: '/api/v1/auth/me', cookies: { '__Host-commerce_session': session },
    });
    expect(withPrefix.statusCode).toBe(200);

    // 子網域寫得出裸名的 cookie。伺服器若肯回退去讀它，前綴買到的保護就全部還回去了。
    const bare = await inject({
      method: 'GET', url: '/api/v1/auth/me', cookies: { commerce_session: session },
    });
    expect(bare.statusCode).toBe(401);
  });

  it('訪客購物車的 cookie 也帶前綴，而且讀得回同一台車', async () => {
    const product = await createProduct(h.runtime, { sku: `HOST-${randomUUID().slice(0, 6)}`, name: '前綴商品', priceCents: 1_000 });
    await stockUp(h.runtime, product.id, 5);

    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 },
    });
    expect(added.statusCode).toBe(201);

    const cart = added.cookies.find((c) => c.name === '__Host-commerce_cart')!;
    expect(cart).toBeTruthy();
    expect(cart.secure).toBe(true);
    expect(cart.path).toBe('/');

    const fetched = await inject({
      method: 'GET', url: '/api/v1/cart', cookies: { '__Host-commerce_cart': cart.value },
    });
    expect(fetched.json().data.items).toHaveLength(1);

    const bare = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { commerce_cart: cart.value } });
    expect(bare.json().data.items).toHaveLength(0);
  });

  it('合併提示這張 cookie 也帶前綴，而且下一頁讀得到、讀完就清掉', async () => {
    const product = await createProduct(h.runtime, { sku: `HOST-GONE-${randomUUID().slice(0, 6)}`, name: '下架商品', priceCents: 1_500 });
    await stockUp(h.runtime, product.id, 5);

    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 },
    });
    const guest = added.cookies.find((c) => c.name === '__Host-commerce_cart')!.value;

    // 下架之後才合併：removedNames 非空，提示才會真的被寫出來。
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: `arch-${product.id}` });

    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email: `host-notice-${randomUUID()}@example.test`, password: 'a-good-password', displayName: '提示' },
      cookies: { '__Host-commerce_cart': guest },
    });
    const notice = registered.cookies.find((c) => c.name === '__Host-commerce_cart_notice')!;
    expect(notice.value).toContain('下架商品');
    expect(notice.secure).toBe(true);
    expect(notice.path).toBe('/');
    expect(registered.cookies.find((c) => c.name === 'commerce_cart_notice')).toBeUndefined();

    // 讀取與清除都得用同一個名字，否則提示會在每一頁重複出現、永遠清不掉。
    const session = registered.cookies.find((c) => c.name === '__Host-commerce_session')!.value;
    const page = await inject({
      method: 'GET', url: '/',
      cookies: { '__Host-commerce_session': session, '__Host-commerce_cart_notice': notice.value },
    });
    expect(page.body).toContain('下架商品');
    expect(page.cookies.find((c) => c.name === '__Host-commerce_cart_notice')!.value).toBe('');

    const again = await inject({ method: 'GET', url: '/', cookies: { '__Host-commerce_session': session } });
    expect(again.body).not.toContain('下架商品');
  });

  it('登入後的伺服器渲染頁面認得出身分，CSRF 隱藏欄位跟著出現', async () => {
    const product = await createProduct(h.runtime, { sku: `HOST-SSR-${randomUUID().slice(0, 6)}`, name: 'SSR 商品', priceCents: 1_200 });
    await stockUp(h.runtime, product.id, 5);

    const registered = await register(`host-ssr-${randomUUID()}@example.test`);
    const session = registered.cookies.find((c) => c.name === '__Host-commerce_session')!.value;

    // themeContext 由 session token 推導出隱藏欄位；名字讀錯的話登入後每一張表單都會變成 403。
    const page = await inject({
      method: 'GET', url: `/p/${product.id}`, cookies: { '__Host-commerce_session': session },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="_csrf"');

    const bare = await inject({ method: 'GET', url: `/p/${product.id}`, cookies: { commerce_session: session } });
    expect(bare.body).not.toContain('name="_csrf"');
  });

  it('登入時合併訪客購物車走的也是前綴名', async () => {
    const product = await createProduct(h.runtime, { sku: `HOST-M-${randomUUID().slice(0, 6)}`, name: '合併商品', priceCents: 2_000 });
    await stockUp(h.runtime, product.id, 5);

    const added = await inject({
      method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 2 },
    });
    const guest = added.cookies.find((c) => c.name === '__Host-commerce_cart')!.value;

    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email: `host-merge-${randomUUID()}@example.test`, password: 'a-good-password', displayName: '合併' },
      cookies: { '__Host-commerce_cart': guest },
    });
    expect(registered.statusCode).toBe(201);

    // 併過的訪客 cookie 立刻作廢，清除用的名字也必須是前綴名，否則清不到。
    const cleared = registered.cookies.find((c) => c.name === '__Host-commerce_cart')!;
    expect(cleared.value).toBe('');

    const session = registered.cookies.find((c) => c.name === '__Host-commerce_session')!.value;
    const mine = await inject({
      method: 'GET', url: '/api/v1/cart', cookies: { '__Host-commerce_session': session },
    });
    expect(mine.json().data.items[0].quantity).toBe(2);
  });

  it('伺服器渲染的購物車頁走的也是前綴名', async () => {
    const product = await createProduct(h.runtime, { sku: `HOST-P-${randomUUID().slice(0, 6)}`, name: '頁面商品', priceCents: 3_000 });
    await stockUp(h.runtime, product.id, 5);

    const added = await inject({
      method: 'POST', url: '/cart/items',
      payload: `productId=${product.id}&quantity=1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cart = added.cookies.find((c) => c.name === '__Host-commerce_cart');
    expect(cart).toBeTruthy();

    const page = await inject({ method: 'GET', url: '/cart', cookies: { '__Host-commerce_cart': cart!.value } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('頁面商品');

    // 裸名不被採信：同一張 token 換個名字送進來，頁面上不該有那台車。
    const bare = await inject({ method: 'GET', url: '/cart', cookies: { commerce_cart: cart!.value } });
    expect(bare.body).not.toContain('頁面商品');
  });

  it('登出清掉的是前綴名的那兩張', async () => {
    const registered = await register(`host-out-${randomUUID()}@example.test`);
    const session = registered.cookies.find((c) => c.name === '__Host-commerce_session')!.value;

    const res = await inject({
      method: 'POST', url: '/api/v1/auth/logout',
      cookies: { '__Host-commerce_session': session },
      headers: { 'x-csrf-token': csrfTokenFor(session) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === '__Host-commerce_session')!.value).toBe('');
    expect(res.cookies.find((c) => c.name === '__Host-commerce_csrf')!.value).toBe('');
  });
});
