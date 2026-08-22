import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ADMIN_ACTOR, createHarness, createProduct, defaultCustomer, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

/**
 * 這個檔案共用一個資料庫，活動是全域狀態。統一在 afterEach 停用，
 * 否則任何一次斷言失敗都會讓殘留的活動污染後面每一個測試。
 */
const created: string[] = [];

const createPromotion = async (input: Record<string, unknown>) => {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', input, { actor: ADMIN_ACTOR });
  created.push(promotion.id);
  return promotion;
};

afterEach(async () => {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
      { id, status: 'disabled' }, { actor: ADMIN_ACTOR });
  }
});

// 下單者由身分決定（工單 21）：測試裡的每一張訂單都出自一位真的顧客。
const order = async (productId: string, quantity = 1) =>
  h.runtime.commands.execute<any>('commerce.order.placeOrder',
    { lines: [{ productId, quantity }] },
    { actor: await defaultCustomer(h.runtime), idempotencyKey: randomUUID() });

const orderLines = async (lines: { productId: string; quantity: number }[]) =>
  h.runtime.commands.execute<any>('commerce.order.placeOrder',
    { lines },
    { actor: await defaultCustomer(h.runtime), idempotencyKey: randomUUID() });

async function sellableProduct(sku: string, priceCents: number) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

describe('下單套用定價引擎', () => {
  it('沒有任何活動成立時，訂單金額與現況完全相同', async () => {
    await createPromotion({
      name: '門檻高到不會成立',
      rule: { type: 'threshold_fixed_amount', thresholdCents: 99_999_999, discountCents: 10_000 },
    });
    const product = await sellableProduct('PRICE-NONE', 30_000);
    const placed = await order(product.id, 2);

    expect(placed.subtotalCents).toBe(60_000);
    expect(placed.discountCents).toBe(0);
    expect(placed.totalCents).toBe(60_000);
    expect(placed.adjustments).toEqual([]);
    expect(placed.lines[0].discountCents).toBe(0);
  });

  it('活動成立時折扣算進總額、分攤到商品行，並記下用了哪些活動', async () => {
    const promotion = await createPromotion({
      name: '滿千折百',
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    });
    const product = await sellableProduct('PRICE-FIXED', 50_000);

    const placed = await order(product.id, 3);

    expect(placed.subtotalCents).toBe(150_000);
    expect(placed.discountCents).toBe(10_000);
    expect(placed.totalCents).toBe(140_000);
    expect(placed.adjustments).toEqual([
      { source: 'promotion', sourceId: promotion.id, name: '滿千折百', amountCents: -10_000 },
    ]);
    expect(placed.lines[0].discountCents).toBe(10_000);

    // 折扣與明細落在資料庫，不只是回傳值
    const rows = await h.runtime.database.db.execute<{ discount_cents: number; total_cents: number }>(sql`
      SELECT discount_cents, total_cents FROM order_orders WHERE id = ${placed.id}
    `);
    expect(rows.rows[0].discount_cents).toBe(10_000);
    expect(rows.rows[0].total_cents).toBe(140_000);

  });

  it('停用的活動不再影響新訂單', async () => {
    const promotion = await createPromotion({
      name: '要被停用的九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
      { id: promotion.id, status: 'disabled' }, { actor: ADMIN_ACTOR });

    const product = await sellableProduct('PRICE-DISABLED', 20_000);
    const placed = await order(product.id);

    expect(placed.discountCents).toBe(0);
    expect(placed.totalCents).toBe(20_000);
  });

  it('新版事件帶出正確的調整明細，舊版仍是折扣前後一致的總額語意', async () => {
    const promotion = await createPromotion({
      name: '全站九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    const product = await sellableProduct('PRICE-EVENT', 10_000);

    const placed = await order(product.id);

    const rows = await h.runtime.database.db.execute<{ event_name: string; payload: any }>(sql`
      SELECT event_name, payload FROM platform_outbox
      WHERE payload->>'orderId' = ${placed.id} AND event_name LIKE 'commerce.order.placed%'
      ORDER BY event_name
    `);
    const byName = Object.fromEntries(rows.rows.map((r) => [r.event_name, r.payload]));

    expect(byName['commerce.order.placed.v3'].discountCents).toBe(1_000);
    expect(byName['commerce.order.placed.v3'].totalCents).toBe(9_000);
    expect(byName['commerce.order.placed.v3'].adjustments).toEqual([
      { source: 'promotion', sourceId: promotion.id, name: '全站九折', amountCents: -1_000 },
    ]);
    expect(byName['commerce.order.placed.v3'].lines[0].netCents).toBe(9_000);
    // 舊版沒有折扣欄位，它的 totalCents 一律是這張訂單的應付金額
    expect(byName['commerce.order.placed.v1'].totalCents).toBe(9_000);
    expect(byName['commerce.order.placed.v1']).not.toHaveProperty('discountCents');

  });

  it('定價與訂單建立在同一個交易內：下單失敗時不留下任何調整明細', async () => {
    const promotion = await createPromotion({
      name: '交易測試用九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    const product = await sellableProduct('PRICE-ROLLBACK', 10_000);

    // 庫存不足會讓整筆下單回滾
    await expect(order(product.id, 999)).rejects.toThrow();

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_adjustments
      WHERE source_id = ${promotion.id}
    `);
    expect(rows.rows[0].count).toBe('0');

  });
});

describe('結帳前試算', () => {
  const quote = (lines: { productId: string; quantity: number }[], actor = ADMIN_ACTOR) =>
    h.runtime.queries.execute<any>('commerce.promotion.quote', { lines }, { actor });

  it('試算與實際下單得到完全相同的調整明細與金額', async () => {
    const promotion = await createPromotion({
      name: '試算比對用滿千折百',
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    });
    const a = await sellableProduct('QUOTE-A', 60_000);
    const b = await sellableProduct('QUOTE-B', 40_000);
    const lines = [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }];

    const quoted = await quote(lines);
    const placed = await orderLines(lines);

    expect(quoted.subtotalCents).toBe(placed.subtotalCents);
    expect(quoted.discountCents).toBe(placed.discountCents);
    expect(quoted.totalCents).toBe(placed.totalCents);
    expect(quoted.adjustments).toEqual(placed.adjustments);
    expect(quoted.lines.map((l: any) => [l.productId, l.discountCents])).toEqual(
      placed.lines.map((l: any) => [l.productId, l.discountCents]),
    );

  });

  it('餘數與同額行的分攤，試算與下單逐行相同', async () => {
    await createPromotion({
      name: '除不盡的九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    // 三行等額：折 10% 後每行 3_333.3，餘數與同額 tie-break 都會被踩到
    const a = await sellableProduct('QUOTE-TIE-A', 33_333);
    const b = await sellableProduct('QUOTE-TIE-B', 33_333);
    const c = await sellableProduct('QUOTE-TIE-C', 33_333);
    const lines = [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
      { productId: c.id, quantity: 1 },
    ];

    const quoted = await quote(lines);
    const placed = await orderLines(lines);

    expect(quoted.discountCents).toBe(10_000);
    expect(quoted.discountCents).toBe(placed.discountCents);
    // 逐行比對：餘數落在哪一行，兩邊必須是同一行
    const byProduct = (rows: any[]) =>
      Object.fromEntries(rows.map((l: any) => [l.productId, l.discountCents]));
    expect(byProduct(quoted.lines)).toEqual(byProduct(placed.lines));
    expect(Object.values(byProduct(placed.lines)).sort()).toEqual([3_333, 3_333, 3_334]);
  });

  it('同一個商品出現在兩行、以及行順序顛倒時，試算與下單仍然一致', async () => {
    await createPromotion({
      name: '重複商品用九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    const cheap = await sellableProduct('QUOTE-DUP-A', 1_111);
    const rich = await sellableProduct('QUOTE-DUP-B', 9_999);

    for (const lines of [
      [{ productId: cheap.id, quantity: 1 }, { productId: rich.id, quantity: 1 }, { productId: cheap.id, quantity: 2 }],
      [{ productId: rich.id, quantity: 1 }, { productId: cheap.id, quantity: 3 }],
    ]) {
      const quoted = await quote(lines);
      const placed = await orderLines(lines);

      expect(quoted.totalCents).toBe(placed.totalCents);
      expect(quoted.lines.map((l: any) => [l.productId, l.quantity, l.discountCents]))
        .toEqual(placed.lines.map((l: any) => [l.productId, l.quantity, l.discountCents]));
    }
  });

  it('試算不寫入任何資料，也不佔用庫存', async () => {
    const product = await sellableProduct('QUOTE-NOWRITE', 10_000);
    const before = await h.runtime.queries.execute<any>('commerce.inventory.getStock',
      { productId: product.id }, { actor: ADMIN_ACTOR });

    await quote([{ productId: product.id, quantity: 5 }]);
    await quote([{ productId: product.id, quantity: 5 }]);

    const after = await h.runtime.queries.execute<any>('commerce.inventory.getStock',
      { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(after).toEqual(before);

    const orders = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE subtotal_cents = 50000
    `);
    expect(orders.rows[0].count).toBe('0');
  });

  it('試算查得到每一行的名稱與單價，前台才顯示得出明細', async () => {
    const product = await sellableProduct('QUOTE-DETAIL', 12_345);
    const quoted = await quote([{ productId: product.id, quantity: 2 }]);

    expect(quoted.lines[0]).toMatchObject({
      productId: product.id,
      sku: 'QUOTE-DETAIL',
      unitPriceCents: 12_345,
      quantity: 2,
      lineTotalCents: 24_690,
      netCents: 24_690,
    });
  });

  it('下架商品無法試算，與下單的行為一致', async () => {
    const draft = await createProduct(h.runtime, { sku: 'QUOTE-DRAFT', name: 'draft', status: 'draft' });
    await expect(quote([{ productId: draft.id, quantity: 1 }])).rejects.toThrow();
  });
});
