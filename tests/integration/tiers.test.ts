import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, payOrder, placeOrder,
  runJobsUntilProcessed, stockUp, type TestHarness,
} from './helpers';

/** 等級積分帳本與會員等級（工單 43、45）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const myTier = (actor: any) => h.runtime.queries.execute<any>('commerce.loyalty.getMyTier', {}, { actor });

const listTiers = () => h.runtime.queries.execute<any>('commerce.loyalty.listTiers', {}, { actor: ADMIN_ACTOR });

const saveTier = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.loyalty.saveTier', input, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const adjustPoints = (customerId: string, points: number) =>
  h.runtime.commands.execute<any>('commerce.loyalty.adjustTierPoints',
    { customerId, points, reason: '測試用' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const myRewards = (actor: any) => h.runtime.queries.execute<any>('commerce.loyalty.getMyRewards', {}, { actor });

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `TIER-${randomUUID().slice(0, 8)}`, name: 'tier', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

async function buyAndPay(customer: any, priceCents: number) {
  const product = await sellable(priceCents);
  const order = await placeOrder(h.runtime, product.id, 1, customer);
  await payOrder(h.runtime, order.id);
  await runJobsUntilProcessed(h.worker);
  return order;
}

const buyer = (tag: string) => createCustomer(h.runtime, { email: `tier-${tag}-${randomUUID()}@example.test` });

describe('等級的設定', () => {
  it('預設有三級，門檻由低到高', async () => {
    const { items } = await listTiers();
    expect(items.map((t: any) => t.name)).toEqual(['一般會員', '銀卡', '金卡']);
    expect(items[0].thresholdPoints).toBe(0);
  });

  it('門檻與名稱由後台設定，同名就是修改', async () => {
    await saveTier({ name: '白金卡', thresholdPoints: 50_000, multiplierBasisPoints: 20_000 });
    expect((await listTiers()).items.map((t: any) => t.name)).toContain('白金卡');

    await saveTier({ name: '白金卡', thresholdPoints: 40_000, multiplierBasisPoints: 20_000 });
    const platinum = (await listTiers()).items.find((t: any) => t.name === '白金卡');
    expect(platinum.thresholdPoints).toBe(40_000);
    expect((await listTiers()).items.filter((t: any) => t.name === '白金卡')).toHaveLength(1);

    await h.runtime.commands.execute('commerce.loyalty.removeTier', { name: '白金卡' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  });

  it('保底那一級不能被移除：沒有它，新會員不屬於任何等級', async () => {
    await expect(h.runtime.commands.execute('commerce.loyalty.removeTier', { name: '一般會員' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect((await listTiers()).items.map((t: any) => t.name)).toContain('一般會員');
  });
});

describe('等級積分', () => {
  it('新會員是最低的那一級，說得出還差多少升級', async () => {
    const customer = await buyer('new');

    const status = await myTier(customer);

    expect(status.points).toBe(0);
    expect(status.current.name).toBe('一般會員');
    expect(status.next).toMatchObject({ remainingPoints: 3_000 });
    expect(status.windowMonths).toBe(12);
  });

  it('付款完成時累積等級積分：每消費一元一點', async () => {
    const customer = await buyer('earn');
    await buyAndPay(customer, 400_000);

    expect((await myTier(customer)).points).toBe(4_000);
    expect((await myTier(customer)).current.name).toBe('銀卡');
  });

  it('等級積分與購物金是兩本帳，數字不同、能力也不同', async () => {
    const customer = await buyer('two-ledgers');
    await buyAndPay(customer, 400_000);

    // 等級積分 4,000 點；購物金 1% = 4,000 分（40 元），兩者剛好同數字但不同單位。
    expect((await myTier(customer)).points).toBe(4_000);
    expect((await myRewards(customer)).balance.pendingCents).toBe(4_000);

    // 等級積分折抵不了任何金額——它連進入定價的路徑都沒有。
    const entries = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_tier_entries WHERE customer_id = ${customer.customerId}
    `);
    expect(entries.rows[0].count).toBe('1');
  });

  it('說得出滾動期間的起點——降級時要解釋得了為什麼', async () => {
    const customer = await buyer('window');
    const status = await myTier(customer);

    const expected = new Date(status.windowStartsAt);
    expect(Date.now() - expected.getTime()).toBeGreaterThan(360 * 24 * 60 * 60 * 1000);
  });

  it('手動調整積分會立刻反映在等級上', async () => {
    const customer = await buyer('manual');

    await adjustPoints(customer.customerId, 10_500);

    expect((await myTier(customer)).current.name).toBe('金卡');
    expect((await myTier(customer)).next).toBeNull();
  });

  it('掉出滾動期間的積分不再算數', async () => {
    const customer = await buyer('rolling');
    await adjustPoints(customer.customerId, 5_000);
    expect((await myTier(customer)).current.name).toBe('銀卡');

    await h.runtime.database.db.execute(sql`
      UPDATE loyalty_tier_entries SET earned_at = now() - interval '13 months'
      WHERE customer_id = ${customer.customerId}
    `);

    expect((await myTier(customer)).points).toBe(0);
    expect((await myTier(customer)).current.name).toBe('一般會員');
  });
});

describe('等級的實質待遇', () => {
  it('購物金累積倍率依等級調整', async () => {
    const customer = await buyer('multiplier');
    await adjustPoints(customer.customerId, 10_000); // 金卡：1.5 倍

    await buyAndPay(customer, 100_000);

    // 1% of 100,000 = 1,000，乘上金卡的 1.5 倍 = 1,500
    expect((await myRewards(customer)).balance.pendingCents).toBe(1_500);
  });

  it('等級限定的活動只對符合的人套用', async () => {
    const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
      name: '金卡限定九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      tierNames: ['金卡'],
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    try {
      const plain = await buyer('plain');
      const gold = await buyer('gold');
      await adjustPoints(gold.customerId, 10_000);

      const product = await sellable(10_000);
      await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
        { actor: plain, idempotencyKey: randomUUID() });
      await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
        { actor: gold, idempotencyKey: randomUUID() });

      const plainCart = await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: plain });
      const goldCart = await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: gold });

      expect(plainCart.discountCents).toBe(0);
      expect(goldCart.discountCents).toBe(1_000);
    } finally {
      await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
        { id: promotion.id, status: 'disabled' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    }
  });
});

describe('等級的刪除', () => {
  it('還有活動指名這一級時刪不掉——刪掉會讓那檔活動安靜地永遠不套用', async () => {
    await saveTier({ name: '鑽石卡', thresholdPoints: 90_000, multiplierBasisPoints: 30_000 });
    const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
      name: `鑽石限定-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      tierNames: ['鑽石卡'],
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    try {
      await expect(h.runtime.commands.execute('commerce.loyalty.removeTier', { name: '鑽石卡' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally {
      await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
        { id: promotion.id, status: 'disabled' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
      await h.runtime.database.db.execute(sql`DELETE FROM promotion_promotions WHERE id = ${promotion.id}`);
      await h.runtime.commands.execute('commerce.loyalty.removeTier', { name: '鑽石卡' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    }
  });
});
