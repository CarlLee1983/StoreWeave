import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doctor } from '@storeweave/kernel';
import { ADMIN_ACTOR, createHarness, createProduct, payOrder, placeOrder, stockUp, type TestHarness } from './helpers';

/**
 * 第二家店只用「設定 + Theme + Extension 組合」建立：
 * 同一份 Application Artifact、同一組 Core 模組，沒有任何客戶條件判斷。
 */
let storeA: TestHarness;
let storeB: TestHarness;

beforeAll(async () => {
  storeA = await createHarness({
    storeId: 'example-store',
    extensions: { 'mock-payment': { autoApprove: true }, 'demo-erp': { endpoint: 'mock://demo-erp' }, mcp: {} },
  });
  storeB = await createHarness({
    storeId: 'aurora-books',
    // 這家店不接 ERP，MCP 只開放唯讀工具
    extensions: {
      'mock-payment': { autoApprove: true },
      mcp: { serverName: 'aurora-books-commerce', enabledTools: ['search_products', 'get_order', 'get_sales_summary'] },
    },
  });
}, 300_000);

afterAll(async () => {
  await storeA?.close();
  await storeB?.close();
});

describe('第二家範例商店', () => {
  it('兩家店載入相同的 Core Command 與 Query', () => {
    const coreCommands = (h: TestHarness) => h.runtime.commands.list().filter((c) => c.descriptor.name.startsWith('commerce.')).map((c) => c.descriptor.name).sort();
    expect(coreCommands(storeB)).toEqual(coreCommands(storeA));
    const coreQueries = (h: TestHarness) => h.runtime.queries.list().filter((q) => q.descriptor.name.startsWith('commerce.')).map((q) => q.descriptor.name).sort();
    expect(coreQueries(storeB)).toEqual(coreQueries(storeA));
  });

  it('Extension 組合不同：B 店沒有 ERP', () => {
    expect(storeA.runtime.extensions.list().map((e) => e.id).sort()).toEqual(['demo-erp', 'mcp', 'mock-payment']);
    expect(storeB.runtime.extensions.list().map((e) => e.id).sort()).toEqual(['mcp', 'mock-payment']);
    expect(storeB.runtime.extensions.find('demo-erp')).toBeUndefined();
  });

  it('MCP 工具集合由設定決定', () => {
    expect(storeA.runtime.mcpTools.list()).toHaveLength(4);
    expect(storeB.runtime.mcpTools.list().map((t) => t.definition.name).sort())
      .toEqual(['get_order', 'get_sales_summary', 'search_products']);
  });

  it('沒有訂閱者時 outbox 仍然乾淨地轉送完成', async () => {
    const product = await createProduct(storeB.runtime, { priceCents: 3000 });
    await stockUp(storeB.runtime, product.id, 5);
    const order = await placeOrder(storeB.runtime, product.id, 1);
    await payOrder(storeB.runtime, order.id);

    const result = await storeB.worker.drain();
    expect(result.relayed).toBeGreaterThan(0);
    expect(result.jobsFailed).toBe(0);
    const stats = await storeB.runtime.outbox.stats(storeB.runtime.database.db);
    expect(stats.pending).toBe(0);
    expect(stats.dead).toBe(0);
  });

  it('訂單編號前綴來自設定的 store id', async () => {
    const product = await createProduct(storeB.runtime);
    await stockUp(storeB.runtime, product.id, 2);
    const order = await placeOrder(storeB.runtime, product.id, 1);
    expect(order.number).toMatch(/^TST-\d+$/);
  });

  it('doctor 對兩家店都能給出結論，並指出 B 店沒有啟用 ERP', async () => {
    const checksA = await doctor(storeA.runtime, { releaseVersion: 'test', configPath: '<test>' });
    const checksB = await doctor(storeB.runtime, { releaseVersion: 'test', configPath: '<test>' });

    expect(checksA.find((c) => c.name === 'postgresql connection')?.status).toBe('pass');
    expect(checksA.find((c) => c.name === 'provider:payment:mock-payment')?.status).toBe('pass');
    expect(checksA.find((c) => c.name === 'extension status: demo-erp')?.status).toBe('pass');
    expect(checksB.find((c) => c.name === 'extension status: demo-erp')?.status).toBe('warn');
    expect(checksB.find((c) => c.name === 'extension status: mcp')?.detail).toContain('aurora-books-commerce');
    expect(checksA.every((c) => c.name !== 'extension compatibility: demo-erp' || c.status === 'pass')).toBe(true);
  });

  it('啟用不存在的 Extension 會在啟動時明確失敗', async () => {
    await expect(createHarness({ extensions: { 'customer-special-thing': {} } })).rejects.toThrow(/not present in this release/);
  }, 60_000);
});
