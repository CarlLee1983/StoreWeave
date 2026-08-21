import type { z } from 'zod';
import { sql } from 'drizzle-orm';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import {
  getOrderInput, listOrdersInput, listOrdersOutput, orderDto,
  salesSummaryInput, salesSummaryOutput,
} from './dto';
import { OrderRepository, toOrderDto } from './repository';

const repository = new OrderRepository();

export const getOrderQuery = defineQuery({
  name: 'commerce.order.getOrder',
  summary: '依 id 或訂單編號取得訂單',
  input: getOrderInput,
  output: orderDto,
  permission: 'order:read',
});

export const getOrderHandler = async (input: z.infer<typeof getOrderInput>, ctx: QueryContext) => {
  const row = input.id
    ? await repository.findById(ctx.db, input.id)
    : await repository.findByNumber(ctx.db, input.number!);
  if (!row) throw PlatformError.notFound('Order', input.id ?? input.number);
  return toOrderDto(row, await repository.linesFor(ctx.db, row.id));
};

export const listOrdersQuery = defineQuery({
  name: 'commerce.order.listOrders',
  summary: '列出訂單',
  input: listOrdersInput,
  output: listOrdersOutput,
  permission: 'order:read',
});

export const listOrdersHandler = async (input: z.infer<typeof listOrdersInput>, ctx: QueryContext) => {
  const { rows, total } = await repository.list(ctx.db, input);
  const items = [];
  for (const row of rows) {
    items.push(toOrderDto(row, await repository.linesFor(ctx.db, row.id)));
  }
  return { items, total };
};

export const salesSummaryQuery = defineQuery({
  name: 'commerce.order.salesSummary',
  summary: '銷售摘要（訂單數、營收、熱賣商品）',
  input: salesSummaryInput,
  output: salesSummaryOutput,
  permission: 'analytics:read',
});

export const salesSummaryHandler = async (
  input: z.infer<typeof salesSummaryInput>,
  ctx: QueryContext,
) => {
  const from = input.from ?? null;
  const to = input.to ?? null;
  const fromClause = from ? sql`AND o.placed_at >= ${from.toISOString()}` : sql``;
  const toClause = to ? sql`AND o.placed_at <= ${to.toISOString()}` : sql``;

  const totals = await ctx.db.execute<{ status: string; count: string; revenue: string; currency: string | null }>(sql`
    SELECT o.status,
           count(*)::text AS count,
           COALESCE(sum(o.total_cents), 0)::text AS revenue,
           min(o.currency) AS currency
    FROM order_orders o
    WHERE true ${fromClause} ${toClause}
    GROUP BY o.status
  `);

  let paid = 0, pending = 0, cancelled = 0, gross = 0, currency = 'TWD';
  for (const row of totals.rows) {
    const count = Number(row.count);
    if (row.status === 'paid') { paid = count; gross = Number(row.revenue); currency = row.currency ?? currency; }
    else if (row.status === 'pending' || row.status === 'payment_processing') pending += count;
    else if (row.status === 'cancelled') cancelled = count;
  }

  const top = await ctx.db.execute<{ product_id: string; sku: string; name: string; quantity: string; revenue: string }>(sql`
    SELECT l.product_id, l.sku, min(l.name) AS name,
           sum(l.quantity)::text AS quantity,
           sum(l.line_total_cents)::text AS revenue
    FROM order_lines l
    JOIN order_orders o ON o.id = l.order_id
    WHERE o.status = 'paid' ${fromClause} ${toClause}
    GROUP BY l.product_id, l.sku
    ORDER BY sum(l.line_total_cents) DESC
    LIMIT 10
  `);

  return {
    from, to, currency,
    paidOrderCount: paid,
    pendingOrderCount: pending,
    cancelledOrderCount: cancelled,
    grossRevenueCents: gross,
    averageOrderValueCents: paid > 0 ? Math.round(gross / paid) : 0,
    topProducts: top.rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      quantity: Number(r.quantity),
      revenueCents: Number(r.revenue),
    })),
  };
};
