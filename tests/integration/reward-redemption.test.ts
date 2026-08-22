import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 結帳折抵購物金（工單 41）。 */

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

const grant = (customerId: string, amountCents: number) =>
  h.runtime.commands.execute('commerce.loyalty.adjustRewards',
    { customerId, amountCents, reason: '測試用' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const myRewards = (actor: any) => h.runtime.queries.execute<any>('commerce.loyalty.getMyRewards', {}, { actor });

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `RDM-${randomUUID().slice(0, 8)}`, name: 'rdm', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

/** 一位手上有購物金、車上有東西的顧客。 */
async function shopper(tag: string, priceCents: number, balanceCents: number) {
  const customer = await createCustomer(h.runtime, { email: `rdm-${tag}-${randomUUID()}@example.test` });
  if (balanceCents > 0) await grant(customer.customerId, balanceCents);
  const product = await sellable(priceCents);
  await addToCart(product.id, customer);
  return { customer, product };
}

describe('購物車的折抵', () => {
  it('指定折抵金額後，預估總額跟著變', async () => {
    const { customer } = await shopper('basic', 10_000, 3_000);

    const cart = await setRedemption(2_000, customer);

    expect(cart.totalCents).toBe(8_000);
    expect(cart.reward).toMatchObject({ requestedCents: 2_000, appliedCents: 2_000, availableCents: 3_000 });
    expect(cart.adjustments.at(-1)).toMatchObject({ source: 'reward', amountCents: -2_000 });
  });

  it('折抵上限是可用餘額與商品小計的較小值', async () => {
    const { customer } = await shopper('cap', 5_000, 100_000);

    const cart = await setRedemption(99_999, customer);

    expect(cart.reward).toMatchObject({ maxCents: 5_000, appliedCents: 5_000 });
    expect(cart.totalCents).toBe(0);
  });

  it('還沒生效的購物金不能折抵', async () => {
    const customer = await createCustomer(h.runtime, { email: `rdm-pending-${randomUUID()}@example.test` });
    await grant(customer.customerId, 5_000);
    await h.runtime.database.db.execute(sql`
      UPDATE loyalty_reward_entries SET effective_at = now() + interval '7 days'
      WHERE customer_id = ${customer.customerId}
    `);
    const product = await sellable(10_000);
    await addToCart(product.id, customer);

    const cart = await setRedemption(5_000, customer);

    expect(cart.reward).toMatchObject({ availableCents: 0, appliedCents: 0 });
    expect(cart.totalCents).toBe(10_000);
  });

  it('設成 0 就是不折抵', async () => {
    const { customer } = await shopper('zero', 10_000, 5_000);
    await setRedemption(3_000, customer);

    const cart = await setRedemption(0, customer);

    expect(cart.totalCents).toBe(10_000);
    expect(cart.reward!.appliedCents).toBe(0);
  });

  it('訪客折抵不了：他沒有帳本', async () => {
    const product = await sellable(10_000);
    const guestToken = randomUUID();
    await h.runtime.commands.execute('commerce.cart.addToCart',
      { guestToken, productId: product.id, quantity: 1 }, { actor: STOREFRONT_ACTOR, idempotencyKey: randomUUID() });

    await expect(setRedemption(100, STOREFRONT_ACTOR)).rejects.toThrow(PlatformError);
  });
});

describe('結帳時折抵', () => {
  it('折抵與訂單在同一個交易內成立，帳本記一筆負分錄', async () => {
    const { customer } = await shopper('checkout', 20_000, 8_000);
    await setRedemption(5_000, customer);

    const order = await checkout(customer, (await getCart(customer)).id);

    expect(order.totalCents).toBe(15_000);
    expect(order.adjustments.at(-1)).toMatchObject({ source: 'reward', amountCents: -5_000 });

    const { balance, entries } = await myRewards(customer);
    expect(balance.availableCents).toBe(3_000);
    expect(entries[0]).toMatchObject({ amountCents: -5_000, source: 'redemption', reference: order.id });
  });

  it('折抵分攤到商品行，行折扣合計等於訂單折扣', async () => {
    const customer = await createCustomer(h.runtime, { email: `rdm-alloc-${randomUUID()}@example.test` });
    await grant(customer.customerId, 10_000);
    const a = await sellable(3_333);
    const b = await sellable(1_111);
    await addToCart(a.id, customer, 3);
    await addToCart(b.id, customer, 2);
    await setRedemption(1_234, customer);

    const order = await checkout(customer, (await getCart(customer)).id);

    const lineDiscounts = order.lines.reduce((sum: number, l: any) => sum + l.discountCents, 0);
    expect(lineDiscounts).toBe(order.discountCents);
    expect(order.lines.every((l: any) => l.lineTotalCents - l.discountCents >= 0)).toBe(true);
  });

  it('餘額在結帳前被花光時，結帳當下重新夾限而不是硬扣', async () => {
    const { customer } = await shopper('drained', 20_000, 5_000);
    await setRedemption(5_000, customer);

    // 客服在結帳之前把那筆補償收回去了。
    await grant(customer.customerId, -5_000);

    const order = await checkout(customer, (await getCart(customer)).id);

    expect(order.totalCents).toBe(20_000);
    expect(order.adjustments).toEqual([]);
    expect((await myRewards(customer)).balance.availableCents).toBe(0);
  });

  it('試算與結帳的折抵金額一致', async () => {
    const { customer } = await shopper('same', 12_345, 4_000);
    await setRedemption(4_000, customer);
    const cart = await getCart(customer);

    const order = await checkout(customer, cart.id);

    expect(order.totalCents).toBe(cart.totalCents);
    expect(order.discountCents).toBe(cart.discountCents);
  });
});

describe('前台的折抵入口（工單 41 的缺口）', () => {
  it('REST 端點設定得了折抵金額', async () => {
    const { customer } = await shopper('rest', 10_000, 5_000);

    const cart = await h.runtime.commands.execute<any>('commerce.cart.setRewardRedemption',
      { amountCents: 2_500 }, { actor: customer, idempotencyKey: randomUUID() });

    expect(cart.reward).toMatchObject({ requestedCents: 2_500, appliedCents: 2_500 });
    expect(cart.totalCents).toBe(7_500);
  });
});
