import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 訂單取消時購物金回沖（工單 42）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const addToCart = (productId: string, actor: any, quantity = 1) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', { productId, quantity },
    { actor, idempotencyKey: randomUUID() });

const setRedemption = (amountCents: number, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.setRewardRedemption', { amountCents },
    { actor, idempotencyKey: randomUUID() });

const getCart = (actor: any) => h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor });

const checkout = (actor: any, cartId: string) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId }, { actor, idempotencyKey: randomUUID() });

const cancel = (orderId: string) =>
  h.runtime.commands.execute<any>('commerce.order.cancelOrder', { orderId, reason: 'test' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const grant = (customerId: string, amountCents: number) =>
  h.runtime.commands.execute('commerce.loyalty.adjustRewards',
    { customerId, amountCents, reason: '測試用' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const myRewards = (actor: any) => h.runtime.queries.execute<any>('commerce.loyalty.getMyRewards', {}, { actor });

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `RVS-${randomUUID().slice(0, 8)}`, name: 'rvs', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

async function shopper(tag: string, priceCents: number, balanceCents: number) {
  const customer = await createCustomer(h.runtime, { email: `rvs-${tag}-${randomUUID()}@example.test` });
  if (balanceCents > 0) await grant(customer.customerId, balanceCents);
  const product = await sellable(priceCents);
  await addToCart(product.id, customer);
  return customer;
}

/** 帳本的淨額。可用餘額是它的推導值，兩者必須永遠對得起來。 */
async function ledgerTotal(customerId: string): Promise<number> {
  const rows = await h.runtime.database.db.execute<{ total: string }>(sql`
    SELECT coalesce(sum(amount_cents), 0)::text AS total FROM loyalty_reward_entries WHERE customer_id = ${customerId}
  `);
  return Number(rows.rows[0].total);
}

describe('取消時回沖', () => {
  it('折抵掉的購物金以反向分錄回來，不是把餘額改回去', async () => {
    const customer = await shopper('refund', 20_000, 8_000);
    await setRedemption(5_000, customer);
    const order = await checkout(customer, (await getCart(customer)).id);
    expect((await myRewards(customer)).balance.availableCents).toBe(3_000);

    await cancel(order.id);

    const { balance, entries } = await myRewards(customer);
    expect(balance.availableCents).toBe(8_000);
    // 原本那筆負分錄還在，回沖是新的一筆——帳本只增不改。
    expect(entries[0]).toMatchObject({ amountCents: 5_000, source: 'reversal' });
    expect(entries.filter((e: any) => e.source === 'redemption')).toHaveLength(1);
  });

  it('逾時與取消一樣：那張單沒有成立，折抵掉的就要還他', async () => {
    const customer = await shopper('expire', 20_000, 6_000);
    await setRedemption(4_000, customer);
    const order = await checkout(customer, (await getCart(customer)).id);

    await h.runtime.database.db.execute(sql`
      UPDATE order_orders SET expires_at = now() - interval '1 second' WHERE id = ${order.id}
    `);
    await h.runtime.database.db.execute(sql`
      UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE dedupe_key = ${`order:expire:${order.id}`}
    `);
    await h.worker.drain();

    expect((await myRewards(customer)).balance.availableCents).toBe(6_000);
  });

  it('回沖是冪等的：同一張訂單取消兩次不會還兩次', async () => {
    const customer = await shopper('twice', 20_000, 5_000);
    await setRedemption(5_000, customer);
    const order = await checkout(customer, (await getCart(customer)).id);

    await cancel(order.id);
    await cancel(order.id);

    expect((await myRewards(customer)).balance.availableCents).toBe(5_000);
    expect(await ledgerTotal(customer.customerId)).toBe(5_000);
  });

  it('沒有折抵的訂單取消時什麼都不寫', async () => {
    const customer = await shopper('none', 10_000, 2_000);
    const order = await checkout(customer, (await getCart(customer)).id);
    const before = (await myRewards(customer)).entries.length;

    await cancel(order.id);

    expect((await myRewards(customer)).entries).toHaveLength(before);
  });

  it('一連串入帳、折抵、取消、到期之後，帳本總和與可用餘額仍然一致', async () => {
    const customer = await shopper('ledger', 30_000, 10_000);
    await setRedemption(6_000, customer);
    const order = await checkout(customer, (await getCart(customer)).id);
    await cancel(order.id);

    // 再折一次，這次留著不取消。
    const product = await sellable(30_000);
    await addToCart(product.id, customer);
    await setRedemption(2_500, customer);
    await checkout(customer, (await getCart(customer)).id);

    // 給一筆會過期的，再把它調成已過期。
    await grant(customer.customerId, 1_000);
    await h.runtime.database.db.execute(sql`
      UPDATE loyalty_reward_entries SET expires_at = now() - interval '1 day'
      WHERE customer_id = ${customer.customerId} AND amount_cents = 1000
    `);

    const { balance } = await myRewards(customer);
    expect(balance.availableCents + balance.pendingCents + balance.expiredCents)
      .toBe(await ledgerTotal(customer.customerId));
    expect(balance.availableCents).toBe(7_500);
    expect(balance.expiredCents).toBe(1_000);
  });

  it('扣回尚未生效的累積不會讓餘額變成負數', async () => {
    const customer = await createCustomer(h.runtime, { email: `rvs-neg-${randomUUID()}@example.test` });
    // 模擬「累積了但還沒生效，然後被扣回」：兩筆分錄互相抵銷，可用餘額仍是零。
    // created_at 明確錯開——推導依帳本順序處理扣抵，扣抵排在累積之前是另一種情況。
    await h.runtime.database.db.execute(sql`
      INSERT INTO loyalty_reward_entries (id, customer_id, amount_cents, source, reference, effective_at, expires_at, created_at)
      VALUES
        (${randomUUID()}, ${customer.customerId}, 1000, 'order-accrual', ${randomUUID()},
         now() + interval '7 days', NULL, now() - interval '2 minutes'),
        (${randomUUID()}, ${customer.customerId}, -1000, 'reversal', ${randomUUID()},
         now(), NULL, now() - interval '1 minute')
    `);

    const { balance } = await myRewards(customer);
    expect(balance.availableCents).toBe(0);
    expect(balance.pendingCents).toBe(0);
    expect(await ledgerTotal(customer.customerId)).toBe(0);
  });
});

describe('取消時等級積分也扣回', () => {
  it('與逾時那條路做的事一樣', async () => {
    const customer = await shopper('tierback', 300_000, 0);
    const cartId = (await getCart(customer)).id;
    const order = await checkout(customer, cartId);

    // 積分在付款完成才累積，這裡直接寫一筆掛在這張訂單上，驗的是回沖那一段。
    await h.runtime.database.db.execute(sql`
      INSERT INTO loyalty_tier_entries (id, customer_id, points, source, reference, earned_at)
      -- 往前一分鐘：資料庫的 now() 可能比查詢用的時鐘快幾毫秒，而滾動期間的上界是
      -- 「查詢的當下」——差幾毫秒就會把這一筆排除在期間之外。
      VALUES (${randomUUID()}, ${customer.customerId}, 3000, 'order', ${order.id}, now() - interval '1 minute')
    `);
    expect((await h.runtime.queries.execute<any>('commerce.loyalty.getMyTier', {}, { actor: customer })).points)
      .toBe(3_000);

    await cancel(order.id);

    expect((await h.runtime.queries.execute<any>('commerce.loyalty.getMyTier', {}, { actor: customer })).points)
      .toBe(0);
  });
});
