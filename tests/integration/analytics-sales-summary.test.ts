import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR,
  actorWith,
  createHarness,
  createProduct,
  payOrder,
  placeOrder,
  stockUp,
  type TestHarness,
} from './helpers';

/**
 * commerce.order.salesSummary 的現況迴歸網（工單 01）。
 *
 * 這支查詢在 Spec 0002 會改變語意（營收變成折扣後實收），在 Spec 0005 會搬到獨立的
 * Analytics 頁。它目前沒有任何測試，因此這個檔案的目的是把「現在的行為」釘住 ——
 * 包含幾個不直覺但確實成立的行為，那些正是遷移時最容易無聲改壞的地方。
 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const summary = (input: Record<string, unknown> = {}, actor = ADMIN_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.order.salesSummary', input, { actor });

/** 把訂單的 placed_at 移到指定時間，用來測試區間過濾。 */
async function setPlacedAt(orderId: string, at: string) {
  await h.runtime.database.db.execute(
    sql`UPDATE order_orders SET placed_at = ${at} WHERE id = ${orderId}`,
  );
}

/**
 * 等到訂單真的變成 paid。
 *
 * 付款工作以 `run_at <= now()` 認領，run_at 由 Node 產生而 now() 來自 Postgres，
 * 兩者之間的時鐘偏移會讓單獨一輪 runJobs() 撲空。輪詢到狀態轉換為止才是穩定的做法。
 */
async function settlePayment(orderId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await h.worker.runJobs();
    const order = await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: orderId }, { actor: ADMIN_ACTOR });
    if (order.status === 'paid') return order;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`訂單 ${orderId} 在時限內沒有變成 paid`);
}

async function paidOrder(priceCents: number, quantity: number) {
  const product = await createProduct(h.runtime, { priceCents });
  await stockUp(h.runtime, product.id, quantity + 5);
  const order = await placeOrder(h.runtime, product.id, quantity);
  await payOrder(h.runtime, order.id);
  await settlePayment(order.id);
  return { product, order };
}

describe('commerce.order.salesSummary 的現況', () => {
  it('沒有任何訂單時回傳零值、預設幣別與空的熱銷清單', async () => {
    const result = await summary({ from: new Date('2000-01-01'), to: new Date('2000-12-31') });

    expect(result).toMatchObject({
      currency: 'TWD',
      paidOrderCount: 0,
      pendingOrderCount: 0,
      cancelledOrderCount: 0,
      grossRevenueCents: 0,
      averageOrderValueCents: 0,
      topProducts: [],
    });
  });

  it('已付款訂單計入營收，客單價是四捨五入的整數分', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T23:59:59.999Z');

    const a = await paidOrder(1000, 1);   // 1000
    const b = await paidOrder(1001, 1);   // 1001 → 兩單合計 2001，平均 1000.5
    await setPlacedAt(a.order.id, '2026-01-10T00:00:00.000Z');
    await setPlacedAt(b.order.id, '2026-01-11T00:00:00.000Z');

    const result = await summary({ from, to });

    expect(result.paidOrderCount).toBe(2);
    expect(result.grossRevenueCents).toBe(2001);
    expect(result.averageOrderValueCents).toBe(1001); // Math.round(2001 / 2)
    expect(result.currency).toBe('TWD');
  });

  it('pending 與 payment_processing 一起算進 pendingOrderCount', async () => {
    const from = new Date('2026-02-01T00:00:00.000Z');
    const to = new Date('2026-02-28T23:59:59.999Z');

    const product = await createProduct(h.runtime, { priceCents: 500 });
    await stockUp(h.runtime, product.id, 10);

    const stillPending = await placeOrder(h.runtime, product.id, 1);
    const processing = await placeOrder(h.runtime, product.id, 1);
    await payOrder(h.runtime, processing.id); // 停在 payment_processing，不跑 worker

    await setPlacedAt(stillPending.id, '2026-02-10T00:00:00.000Z');
    await setPlacedAt(processing.id, '2026-02-11T00:00:00.000Z');

    const result = await summary({ from, to });

    expect(result.pendingOrderCount).toBe(2);
    expect(result.paidOrderCount).toBe(0);
    expect(result.grossRevenueCents).toBe(0);
  });

  it('取消的訂單只計入 cancelledOrderCount，不影響營收', async () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-03-31T23:59:59.999Z');

    const product = await createProduct(h.runtime, { priceCents: 700 });
    await stockUp(h.runtime, product.id, 5);
    const order = await placeOrder(h.runtime, product.id, 2);
    await h.runtime.commands.execute('commerce.order.cancelOrder',
      { orderId: order.id, reason: 'test' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await setPlacedAt(order.id, '2026-03-10T00:00:00.000Z');

    const result = await summary({ from, to });

    expect(result.cancelledOrderCount).toBe(1);
    expect(result.paidOrderCount).toBe(0);
    expect(result.grossRevenueCents).toBe(0);
  });

  it('expired 訂單不計入任何一個計數（現況的刻意留白）', async () => {
    const from = new Date('2026-04-01T00:00:00.000Z');
    const to = new Date('2026-04-30T23:59:59.999Z');

    const product = await createProduct(h.runtime, { priceCents: 900 });
    await stockUp(h.runtime, product.id, 5);
    const order = await placeOrder(h.runtime, product.id, 1);
    await h.runtime.database.db.execute(
      sql`UPDATE order_orders SET status = 'expired', placed_at = '2026-04-10T00:00:00.000Z' WHERE id = ${order.id}`,
    );

    const result = await summary({ from, to });

    expect(result).toMatchObject({
      paidOrderCount: 0,
      pendingOrderCount: 0,
      cancelledOrderCount: 0,
      grossRevenueCents: 0,
    });
  });

  it('熱銷商品只看已付款訂單，依營收由高到低排序', async () => {
    const from = new Date('2026-05-01T00:00:00.000Z');
    const to = new Date('2026-05-31T23:59:59.999Z');

    const cheap = await paidOrder(100, 3);   // 300
    const rich = await paidOrder(5000, 2);   // 10000
    await setPlacedAt(cheap.order.id, '2026-05-10T00:00:00.000Z');
    await setPlacedAt(rich.order.id, '2026-05-11T00:00:00.000Z');

    // 同期間內另有一張未付款訂單，不應出現在熱銷清單
    const unpaidProduct = await createProduct(h.runtime, { priceCents: 9999 });
    await stockUp(h.runtime, unpaidProduct.id, 5);
    const unpaid = await placeOrder(h.runtime, unpaidProduct.id, 1);
    await setPlacedAt(unpaid.id, '2026-05-12T00:00:00.000Z');

    const result = await summary({ from, to });

    expect(result.topProducts.map((p: any) => p.productId)).toEqual([rich.product.id, cheap.product.id]);
    expect(result.topProducts[0]).toMatchObject({
      sku: rich.product.sku,
      quantity: 2,
      revenueCents: 10_000,
    });
    expect(result.topProducts[1]).toMatchObject({ quantity: 3, revenueCents: 300 });
  });

  it('熱銷清單最多十筆', async () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-30T23:59:59.999Z');

    for (let i = 0; i < 12; i += 1) {
      const { order } = await paidOrder(100 * (i + 1), 1);
      await setPlacedAt(order.id, '2026-06-10T00:00:00.000Z');
    }

    const result = await summary({ from, to });

    expect(result.topProducts).toHaveLength(10);
    expect(result.paidOrderCount).toBe(12);
  });

  it('區間兩端都是閉區間，落在界線上的訂單算進來', async () => {
    const boundary = '2026-07-15T12:00:00.000Z';
    const { order } = await paidOrder(1500, 1);
    await setPlacedAt(order.id, boundary);

    const inclusive = await summary({ from: new Date(boundary), to: new Date(boundary) });
    expect(inclusive.paidOrderCount).toBe(1);
    expect(inclusive.grossRevenueCents).toBe(1500);

    const after = await summary({
      from: new Date('2026-07-15T12:00:00.001Z'),
      to: new Date('2026-07-31T00:00:00.000Z'),
    });
    expect(after.paidOrderCount).toBe(0);
  });

  it('省略 from/to 時涵蓋全部訂單', async () => {
    const all = await summary({});
    const bounded = await summary({ from: new Date('2026-01-01'), to: new Date('2026-12-31') });

    expect(all.from).toBeNull();
    expect(all.to).toBeNull();
    expect(all.paidOrderCount).toBeGreaterThanOrEqual(bounded.paidOrderCount);
  });

  it('需要 analytics:read 權限', async () => {
    await expect(summary({}, actorWith(['order:read']))).rejects.toThrow();
    await expect(summary({}, actorWith(['analytics:read']))).resolves.toBeTruthy();
  });
});
