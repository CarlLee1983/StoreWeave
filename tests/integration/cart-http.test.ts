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

describe('購物車結帳（工單 28）', () => {
  it('重複送出同一台車的結帳，只會有一張訂單', async () => {
    const product = await sellable('CART-CHECKOUT-HTTP');
    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email: `cart-checkout-${Date.now()}@example.com`, password: 'a-good-password' },
    });
    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const auth = { cookies: { [SESSION_COOKIE]: session }, headers: { 'x-csrf-token': csrfTokenFor(session) } };

    await inject({ method: 'POST', url: '/api/v1/cart/items', ...auth, payload: { productId: product.id, quantity: 2 } });

    const cartId = (await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [SESSION_COOKIE]: session } })).json().data.id;
    const first = await inject({ method: 'POST', url: '/api/v1/cart/checkout', ...auth, payload: { cartId } });
    // 同一台車再送一次——瀏覽器重送表單就是這個樣子。
    const second = await inject({ method: 'POST', url: '/api/v1/cart/checkout', ...auth, payload: { cartId } });

    expect(first.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);

    // 結完帳看到的是空車。
    const after = await inject({ method: 'GET', url: '/api/v1/cart', cookies: { [SESSION_COOKIE]: session } });
    expect(after.json().data.items).toEqual([]);
  });

  it('訪客結不了帳：擋下他的是身分，不是「沒帶 token」', async () => {
    const product = await sellable('CART-CHECKOUT-ANON');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    const guest = added.cookies.find((c) => c.name === CART_COOKIE)!.value;
    const cartId = (await inject({
      method: 'GET', url: '/api/v1/cart', cookies: { [CART_COOKIE]: guest },
    })).json().data.id;

    const res = await inject({
      method: 'POST', url: '/api/v1/cart/checkout', cookies: { [CART_COOKIE]: guest }, payload: { cartId },
    });

    // requireByActor 的 403，而不是 resolveOwner 的 400。
    expect(res.statusCode).toBe(403);
  });
});

describe('沒帶 cartId 的結帳（工單 52）', () => {
  async function member(email: string) {
    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register',
      payload: { email, password: 'a-good-password' },
    });
    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    return { cookies: { [SESSION_COOKIE]: session }, headers: { 'x-csrf-token': csrfTokenFor(session) } };
  }

  it('會員只有一台車，沒帶 cartId 也結得了帳', async () => {
    const product = await sellable('CART-CHECKOUT-NOID');
    const auth = await member(`cart-checkout-noid-${Date.now()}@example.com`);
    await inject({ method: 'POST', url: '/api/v1/cart/items', ...auth, payload: { productId: product.id, quantity: 1 } });

    const res = await inject({ method: 'POST', url: '/api/v1/cart/checkout', ...auth, payload: {} });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.lines).toHaveLength(1);
  });

  it('沒有車的會員拿到的是「車是空的」，不是指著陌生 uuid 的 404', async () => {
    const auth = await member(`cart-checkout-nocart-${Date.now()}@example.com`);

    const res = await inject({ method: 'POST', url: '/api/v1/cart/checkout', ...auth, payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // 現產的 uuid 不該出現在訊息裡——那個識別碼在資料庫裡不存在，講出來只會誤導。
    expect(res.json().error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('訪客沒帶 cartId 時，擋下他的仍然是身分而不是「找不到那台車」', async () => {
    const product = await sellable('CART-CHECKOUT-NOID-ANON');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    const guest = added.cookies.find((c) => c.name === CART_COOKIE)!.value;

    const res = await inject({
      method: 'POST', url: '/api/v1/cart/checkout', cookies: { [CART_COOKIE]: guest }, payload: {},
    });

    // requireByActor 的 403，而不是「找不到那台車」——光看狀態碼分不出這兩者。
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.json().error.message).not.toMatch(/[Cc]art|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('折扣碼端點（工單 31）', () => {
  it('套用與移除折扣碼', async () => {
    const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
      name: 'HTTP 券九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      requiresCoupon: true,
    }, { actor: ADMIN_ACTOR, idempotencyKey: `promo-http-${Date.now()}` });
    const code = `HTTP${Date.now()}`;
    await h.runtime.commands.execute('commerce.coupon.createCoupon', { code, promotionId: promotion.id },
      { actor: ADMIN_ACTOR, idempotencyKey: `coupon-http-${Date.now()}` });

    const product = await sellable('CART-COUPON-HTTP');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

    const applied = await inject({ method: 'POST', url: '/api/v1/cart/coupon', cookies, payload: { code } });
    expect(applied.statusCode).toBe(201);
    expect(applied.json().data.coupon.code).toBe(code);
    expect(applied.json().data.discountCents).toBe(500);

    const removed = await inject({ method: 'DELETE', url: '/api/v1/cart/coupon', cookies });
    expect(removed.json().data.coupon).toBeNull();
    expect(removed.json().data.discountCents).toBe(0);

    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus', { id: promotion.id, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: `disable-http-${Date.now()}` });
  });

  it('猜碼會被節流擋下：這條管道通了，限量活動就會被掃光', async () => {
    const product = await sellable('CART-COUPON-BRUTE');
    const added = await inject({ method: 'POST', url: '/api/v1/cart/items', payload: { productId: product.id, quantity: 1 } });
    const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await inject({ method: 'POST', url: '/api/v1/cart/coupon', cookies, payload: { code: `GUESS${i}XYZ` } });
      statuses.push(res.statusCode);
    }

    expect(statuses).toContain(429);
    // 節流之前的嘗試回的是「找不到」，不是別的錯誤——節流不能掩蓋真正的行為。
    expect(statuses[0]).toBe(404);
  });
});
