import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bucketFor, occurrenceKeyFor } from '@storeweave/kernel';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 訪客購物車清理（工單 30）。 */

const DAY = 24 * 60 * 60 * 1000;
const CLEANUP_JOB = 'commerce.cart.purge-stale-guest-carts';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const purge = (input: Record<string, unknown> = {}) =>
  h.runtime.commands.execute<{ deletedCarts: number }>('commerce.cart.purgeStaleGuestCarts', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

async function sellable(sku: string) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents: 1_000 });
  await stockUp(h.runtime, product.id, 10);
  return product;
}

/** 把一台車的最後更新時間往前推，模擬「放著沒動」。 */
async function backdate(cartId: string, days: number) {
  await h.runtime.database.db.execute(sql`
    UPDATE cart_carts SET updated_at = now() - ${`${days} days`}::interval WHERE id = ${cartId}
  `);
}

const cartIdOfGuest = async (guestToken: string) =>
  (await h.runtime.queries.execute<any>('commerce.cart.getCart', { guestToken }, { actor: STOREFRONT_ACTOR })).id;

async function exists(cartId: string): Promise<boolean> {
  const res = await h.runtime.database.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM cart_carts WHERE id = ${cartId}
  `);
  return res.rows[0].count !== '0';
}

describe('訪客購物車清理', () => {
  it('滿三十天沒動的訪客購物車被清掉，連同它的商品行', async () => {
    const product = await sellable(`PURGE-OLD-${randomUUID().slice(0, 6)}`);
    const guestToken = randomUUID();
    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    const cartId = await cartIdOfGuest(guestToken);
    await backdate(cartId, 31);

    await purge();

    expect(await exists(cartId)).toBe(false);
    const items = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM cart_items WHERE cart_id = ${cartId}
    `);
    expect(items.rows[0].count).toBe('0');
  });

  it('還沒滿三十天的訪客購物車留著', async () => {
    const product = await sellable(`PURGE-YOUNG-${randomUUID().slice(0, 6)}`);
    const guestToken = randomUUID();
    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    const cartId = await cartIdOfGuest(guestToken);
    await backdate(cartId, 29);

    await purge();

    expect(await exists(cartId)).toBe(true);
  });

  it('會員的購物車放多久都不清——棄單再行銷要用它', async () => {
    const customer = await createCustomer(h.runtime, { email: `purge-${randomUUID()}@example.test` });
    const product = await sellable(`PURGE-MEMBER-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);
    const cartId = (await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: customer })).id;
    await backdate(cartId, 400);

    await purge();

    expect(await exists(cartId)).toBe(true);
  });

  it('邊界由注入的時刻決定：同一台車在不同的 before 下留或不留', async () => {
    const product = await sellable(`PURGE-EDGE-${randomUUID().slice(0, 6)}`);
    const guestToken = randomUUID();
    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    const cartId = await cartIdOfGuest(guestToken);
    await backdate(cartId, 10);

    // 界線是「這個時刻之前沒再動過的就清」：十天前更新的車，用十一天前當界線還不算過期。
    await purge({ before: new Date(Date.now() - 11 * DAY) });
    expect(await exists(cartId)).toBe(true);

    await purge({ before: new Date(Date.now() - 9 * DAY) });
    expect(await exists(cartId)).toBe(false);
  });

  it('清理由週期性工作執行，連續數個切片各排一次而且各跑一次', async () => {
    const product = await sellable(`PURGE-JOB-${randomUUID().slice(0, 6)}`);
    const guestToken = randomUUID();
    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    const cartId = await cartIdOfGuest(guestToken);
    await backdate(cartId, 45);

    const t0 = new Date('2026-01-05T03:20:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(t0.getTime() + i * DAY));
      await h.worker.runJobs();
    }

    const rows = await h.runtime.database.db.execute<{ dedupe_key: string; status: string }>(sql`
      SELECT dedupe_key, status FROM platform_jobs WHERE type = ${CLEANUP_JOB} ORDER BY dedupe_key
    `);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.status === 'completed')).toBe(true);
    expect(rows.rows.map((r) => r.dedupe_key)).toContain(occurrenceKeyFor(CLEANUP_JOB, bucketFor(t0, DAY)));

    // 工作真的做了事，而不只是被排進去。
    expect(await exists(cartId)).toBe(false);
  });
});
