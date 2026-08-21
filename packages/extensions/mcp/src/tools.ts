import { z } from 'zod';
import { defineMcpTool, type McpToolDefinition } from '@storeweave/extension-sdk';

/**
 * MCP 工具全部宣告成「指向某個 Command 或 Query」。
 * 這個結構讓 MCP 沒有辦法繞過 Application Layer —— 它沒有 repository，也沒有資料庫。
 */
export const searchProductsTool = defineMcpTool({
  name: 'search_products',
  description: '依關鍵字搜尋商品，回傳 SKU、名稱、價格與狀態。',
  input: z.object({
    query: z.string().max(200).optional().describe('關鍵字，比對商品名稱與 SKU'),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  target: { kind: 'query', name: 'commerce.catalog.searchProducts' },
  mapInput: (input) => ({ q: input.query, status: input.status, limit: input.limit, offset: 0 }),
});

export const getOrderTool = defineMcpTool({
  name: 'get_order',
  description: '依訂單編號或訂單 id 取得單一訂單，包含明細與付款狀態。',
  input: z.object({
    orderNumber: z.string().optional(),
    orderId: z.string().uuid().optional(),
  }).refine((v) => Boolean(v.orderNumber || v.orderId), { message: 'orderNumber 或 orderId 至少要有一個' }),
  target: { kind: 'query', name: 'commerce.order.getOrder' },
  mapInput: (input) => ({ id: input.orderId, number: input.orderNumber }),
});

export const getSalesSummaryTool = defineMcpTool({
  name: 'get_sales_summary',
  description: '取得指定期間的銷售摘要：訂單數、營收、平均客單價與熱賣商品。',
  input: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  target: { kind: 'query', name: 'commerce.order.salesSummary' },
  mapInput: (input) => ({ from: input.from, to: input.to }),
});

export const adjustInventoryTool = defineMcpTool({
  name: 'adjust_inventory',
  description: '調整商品庫存。正數為進貨、負數為扣減；必須提供 idempotencyKey。',
  input: z.object({
    productId: z.string().uuid(),
    delta: z.number().int(),
    reason: z.enum(['restock', 'correction', 'damage', 'return', 'manual']).default('manual'),
    reference: z.string().max(200).optional(),
    idempotencyKey: z.string().min(8).max(200),
  }),
  target: { kind: 'command', name: 'commerce.inventory.adjustStock' },
  requiresIdempotencyKey: true,
  mapInput: (input) => ({
    productId: input.productId,
    delta: input.delta,
    reason: input.reason,
    reference: input.reference,
  }),
});

export const ALL_MCP_TOOLS: McpToolDefinition<any, any>[] = [
  searchProductsTool,
  getOrderTool,
  getSalesSummaryTool,
  adjustInventoryTool,
];
