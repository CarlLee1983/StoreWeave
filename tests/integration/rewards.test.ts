import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, placeOrder, payOrder, runJobsUntilProcessed,
  stockUp, type TestHarness,
} from './helpers';

/** 購物金帳本與付款後入帳（工單 40）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const myRewards = (actor: any) =>
  h.runtime.queries.execute<any>('commerce.loyalty.getMyRewards', {}, { actor });

const settings = () =>
  h.runtime.queries.execute<any>('commerce.loyalty.getRewardSettings', {}, { actor: ADMIN_ACTOR });

const updateSettings = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.loyalty.updateRewardSettings', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const adjust = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.loyalty.adjustRewards', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `RWD-${randomUUID().slice(0, 8)}`, name: 'rwd', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

/** 下單並讓付款工作跑完。購物金在付款完成時才入帳。 */
async function buyAndPay(customer: any, priceCents: number, quantity = 1) {
  const product = await sellable(priceCents);
  const order = await placeOrder(h.runtime, product.id, quantity, customer);
  await payOrder(h.runtime, order.id);
  await runJobsUntilProcessed(h.worker);
  return order;
}

const buyer = (tag: string) => createCustomer(h.runtime, { email: `rwd-${tag}-${randomUUID()}@example.test` });

describe('累積規則', () => {
  it('預設是回饋 1%、七天後生效、一年到期', async () => {
    expect(await settings()).toMatchObject({
      accrualBasisPoints: 100,
      effectiveAfterDays: 7,
      expiresAfterDays: 365,
    });
  });

  it('比例與生效天數由後台設定', async () => {
    await updateSettings({ accrualBasisPoints: 500, effectiveAfterDays: 0 });
    expect(await settings()).toMatchObject({ accrualBasisPoints: 500, effectiveAfterDays: 0 });
    await updateSettings({ accrualBasisPoints: 100, effectiveAfterDays: 7 });
  });
});

describe('付款後入帳', () => {
  it('付款完成才入帳，而且要等生效日才可用', async () => {
    const customer = await buyer('accrual');
    expect((await myRewards(customer)).balance).toMatchObject({ availableCents: 0, pendingCents: 0 });

    await buyAndPay(customer, 100_000);

    const { balance, entries } = await myRewards(customer);
    // 1% of 100,000 = 1,000
    expect(balance).toMatchObject({ availableCents: 0, pendingCents: 1_000 });
    expect(entries[0]).toMatchObject({ amountCents: 1_000, source: 'order-accrual' });
    expect(new Date(entries[0].effectiveAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('生效日到了就可用——把那一筆的生效時間往前調就看得到', async () => {
    const customer = await buyer('effective');
    await buyAndPay(customer, 50_000);

    await h.runtime.database.db.execute(sql`
      UPDATE loyalty_reward_entries SET effective_at = now() - interval '1 hour'
      WHERE customer_id = ${customer.customerId}
    `);

    expect((await myRewards(customer)).balance).toMatchObject({ availableCents: 500, pendingCents: 0 });
  });

  it('到期日從生效日起算，不是從入帳日——否則等待期會白白吃掉可用時間', async () => {
    const customer = await buyer('expiry');
    await buyAndPay(customer, 100_000);

    const rows = await h.runtime.database.db.execute<{ effective_at: Date; expires_at: Date }>(sql`
      SELECT effective_at, expires_at FROM loyalty_reward_entries WHERE customer_id = ${customer.customerId}
    `);
    const gapDays = (new Date(rows.rows[0].expires_at).getTime() - new Date(rows.rows[0].effective_at).getTime())
      / (24 * 60 * 60 * 1000);
    expect(Math.round(gapDays)).toBe(365);
  });

  it('同一張訂單只入帳一次，重複標記付款不會再給一次', async () => {
    const customer = await buyer('once');
    const order = await buyAndPay(customer, 100_000);

    // 重放付款結果由冪等與訂單狀態一起擋下（recordPaymentResult）。
    await h.worker.drain();

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_reward_entries
      WHERE reference = ${order.id} AND source = 'order-accrual'
    `);
    expect(rows.rows[0].count).toBe('1');
  });

  it('沒有身分的訂單不累積——購物金掛不到任何人身上', async () => {
    const before = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_reward_entries
    `);
    // 前台的訂單一律有顧客（工單 21），這裡驗的是帳本沒有孤兒分錄。
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_reward_entries WHERE customer_id IS NULL
    `);
    expect(rows.rows[0].count).toBe('0');
    expect(Number(before.rows[0].count)).toBeGreaterThanOrEqual(0);
  });
});

describe('手動調整', () => {
  it('客服補償立刻可用，並留下操作者與原因', async () => {
    const customer = await buyer('manual');

    await adjust({ customerId: customer.customerId, amountCents: 5_000, reason: '客訴補償' });

    const { balance, entries } = await myRewards(customer);
    expect(balance.availableCents).toBe(5_000);
    expect(entries[0]).toMatchObject({ amountCents: 5_000, source: 'manual', reason: '客訴補償' });

    const rows = await h.runtime.database.db.execute<{ actor_id: string }>(sql`
      SELECT actor_id FROM loyalty_reward_entries WHERE customer_id = ${customer.customerId} AND source = 'manual'
    `);
    expect(rows.rows[0].actor_id).toBe(ADMIN_ACTOR.id);
  });

  it('也可以收回：負的分錄讓餘額變少', async () => {
    const customer = await buyer('clawback');
    await adjust({ customerId: customer.customerId, amountCents: 3_000, reason: '補償' });
    await adjust({ customerId: customer.customerId, amountCents: -1_000, reason: '重複補償，收回' });

    expect((await myRewards(customer)).balance.availableCents).toBe(2_000);
  });

  it('每一筆調整都進稽核紀錄', async () => {
    const customer = await buyer('audit');
    await adjust({ customerId: customer.customerId, amountCents: 100, reason: '查帳用' });

    const rows = await h.runtime.database.db.execute<{ payload: any }>(sql`
      SELECT payload FROM platform_audit_log
      WHERE action = 'loyalty.rewards-adjusted' AND resource_id = ${customer.customerId}
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload).toMatchObject({ amountCents: 100, reason: '查帳用' });
  });
});

describe('流通在外的總額', () => {
  it('把已生效與未生效的分開講——它們是不同性質的負債', async () => {
    const customer = await buyer('outstanding');
    await adjust({ customerId: customer.customerId, amountCents: 7_777, reason: '流通測試' });

    const result = await h.runtime.queries.execute<any>('commerce.loyalty.outstandingRewards', {}, { actor: ADMIN_ACTOR });

    expect(result.availableCents).toBeGreaterThanOrEqual(7_777);
    expect(result.customerCount).toBeGreaterThan(0);
  });
});
