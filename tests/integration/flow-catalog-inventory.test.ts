import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import { ADMIN_ACTOR, actorWith, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

describe('流程一：商品與庫存', () => {
  it('建立商品後可以用 id 與 sku 查回同一筆 DTO', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-A', name: '烏龍茶' });
    const byId = await h.runtime.queries.execute<any>('commerce.catalog.getProduct', { id: product.id }, { actor: ADMIN_ACTOR });
    const bySku = await h.runtime.queries.execute<any>('commerce.catalog.getProduct', { sku: 'FLOW1-A' }, { actor: ADMIN_ACTOR });
    expect(byId.id).toBe(product.id);
    expect(bySku.id).toBe(product.id);
    expect(byId).not.toHaveProperty('price_cents'); // 回的是 DTO，不是 ORM entity
  });

  it('建立商品會產生版本化的 commerce.product.created.v1', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-B' });
    const rows = await h.runtime.database.db.execute<{ event_name: string; event_version: number; payload: any }>(sql`
      SELECT event_name, event_version, payload FROM platform_outbox
      WHERE payload->>'productId' = ${product.id}
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].event_name).toBe('commerce.product.created.v1');
    expect(rows.rows[0].event_version).toBe(1);
    expect(rows.rows[0].payload.sku).toBe('FLOW1-B');
  });

  it('重複 SKU 會被拒絕且不留下部分寫入', async () => {
    await createProduct(h.runtime, { sku: 'FLOW1-C' });
    await expect(createProduct(h.runtime, { sku: 'FLOW1-C' })).rejects.toThrow(/already exists/);
    const found = await h.runtime.queries.execute<any>('commerce.catalog.searchProducts', { q: 'FLOW1-C' }, { actor: ADMIN_ACTOR });
    expect(found.total).toBe(1);
  });

  it('調整庫存會產生 commerce.inventory.adjusted.v1 並累計 on hand', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-D' });
    await stockUp(h.runtime, product.id, 10);
    await stockUp(h.runtime, product.id, 5);
    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(15);
    expect(stock.available).toBe(15);

    const events = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox
      WHERE event_name = 'commerce.inventory.adjusted.v1' AND payload->>'productId' = ${product.id}
    `);
    expect(Number(events.rows[0].count)).toBe(2);
  });

  it('庫存扣到負數會被擋下', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-E' });
    await stockUp(h.runtime, product.id, 3);
    await expect(
      h.runtime.commands.execute('commerce.inventory.adjustStock', { productId: product.id, delta: -5, reason: 'correction' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/Insufficient stock/);
    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(3);
  });

  it('adjustStock 沒有 Idempotency Key 會被拒絕', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-F' });
    await expect(
      h.runtime.commands.execute('commerce.inventory.adjustStock', { productId: product.id, delta: 1, reason: 'restock' }, { actor: ADMIN_ACTOR }),
    ).rejects.toThrow(/requires an idempotency key/);
  });

  it('缺少權限的 actor 無法建立商品，也無法讀取', async () => {
    const reader = actorWith(['catalog:read']);
    await expect(
      h.runtime.commands.execute('commerce.catalog.createProduct',
        { sku: 'FLOW1-G', name: 'x', priceCents: 1, currency: 'TWD' },
        { actor: reader, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/Forbidden/);

    const nobody = actorWith([]);
    await expect(
      h.runtime.queries.execute('commerce.catalog.searchProducts', {}, { actor: nobody }),
    ).rejects.toThrow(/Forbidden/);
  });

  it('敏感操作留下 audit log', async () => {
    const product = await createProduct(h.runtime, { sku: 'FLOW1-H' });
    await stockUp(h.runtime, product.id, 7);
    const audits = await h.runtime.audit.list(h.runtime.database.db, { resourceType: 'product', resourceId: product.id });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('catalog.product.created');
    expect(actions).toContain('inventory.stock.adjusted');
    expect(audits[0].actorId).toBe(ADMIN_ACTOR.id);
  });

  it('輸入驗證失敗會回 VALIDATION_ERROR 而不是 500', async () => {
    await expect(
      h.runtime.commands.execute('commerce.catalog.createProduct',
        { sku: 'bad sku!', name: '', priceCents: -1, currency: 'TWD' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' } as Partial<PlatformError>);
  });
});
