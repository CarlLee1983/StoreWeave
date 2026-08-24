import type { z } from 'zod';
import { sql } from 'drizzle-orm';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import {
  getOrderInput, listOrdersInput, listOrdersOutputForActor, orderOutputDto,
  salesSummaryInput, salesSummaryOutput,
} from './dto';
import { customerService } from '@storeweave/customer';
import { OrderRepository, toCustomerOrderDto, toOrderDto } from './repository';

const repository = new OrderRepository();

export const getOrderQuery = defineQuery({
  name: 'commerce.order.getOrder',
  summary: '依 id 或訂單編號取得訂單',
  input: getOrderInput,
  output: orderOutputDto,
  permission: 'order:read',
});

/**
 * 「只能看自己的」由 query handler 依 actor 過濾，不進授權層——授權層維持只比對
 * 權限字串（Spec 0001）。顧客身分一律加上自己的條件，後台角色不加。
 */
async function scopedCustomerId(ctx: QueryContext): Promise<string | null> {
  if (ctx.actor.type !== 'customer') return null;
  return customerService.customerIdOf(ctx.db, ctx.actor);
}

export const getOrderHandler = async (input: z.infer<typeof getOrderInput>, ctx: QueryContext) => {
  const customerId = await scopedCustomerId(ctx);
  const row = input.id
    ? await repository.findById(ctx.db, input.id)
    : await repository.findByNumber(ctx.db, input.number!);
  // 別人的訂單一律回「找不到」而不是「不准看」：後者等於用訂單號枚舉別人的訂單。
  if (!row || (customerId !== null && row.customerId !== customerId)) {
    throw PlatformError.notFound('Order', input.id ?? input.number);
  }
  const order = toOrderDto(
    row,
    await repository.linesFor(ctx.db, row.id),
    await repository.adjustmentsFor(ctx.db, row.id),
    await repository.paymentsFor(ctx.db, row.id),
    await repository.deliveryFor(ctx.db, row.id),
  );
  return ctx.actor.type === 'customer' ? toCustomerOrderDto(order) : order;
};

export const listOrdersQuery = defineQuery({
  name: 'commerce.order.listOrders',
  summary: '列出訂單',
  input: listOrdersInput,
  output: listOrdersOutputForActor,
  permission: 'order:read',
});

export const listOrdersHandler = async (input: z.infer<typeof listOrdersInput>, ctx: QueryContext) => {
  const customerId = await scopedCustomerId(ctx);
  const { rows, total } = await repository.list(ctx.db, { ...input, customerId: customerId ?? undefined });
  const ids = rows.map((row) => row.id);
  const lines = await repository.linesForMany(ctx.db, ids);
  const adjustments = await repository.adjustmentsForMany(ctx.db, ids);
  const payments = await repository.paymentsForMany(ctx.db, ids);
  const deliveries = await repository.deliveriesForMany(ctx.db, ids);
  const items = rows.map((row) => toOrderDto(
      row,
      lines.get(row.id) ?? [],
      adjustments.get(row.id) ?? [],
      payments.get(row.id) ?? [],
      deliveries.get(row.id) ?? null,
    ));
  return {
    items: ctx.actor.type === 'customer' ? items.map(toCustomerOrderDto) : items,
    total,
  };
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
    else if (row.status === 'pending' || row.status === 'payment_processing' || row.status === 'awaiting_payment') pending += count;
    else if (row.status === 'cancelled') cancelled = count;
  }

  const top = await ctx.db.execute<{ product_id: string; sku: string; name: string; quantity: string; revenue: string }>(sql`
    SELECT l.product_id, l.sku, min(l.name) AS name,
           sum(l.quantity)::text AS quantity,
           -- 營收是折扣分攤後的實收，不是牌價；否則報表會比實際入帳虛胖。
           sum(l.line_total_cents - l.discount_cents)::text AS revenue
    FROM order_lines l
    JOIN order_orders o ON o.id = l.order_id
    WHERE o.status = 'paid' ${fromClause} ${toClause}
    GROUP BY l.product_id, l.sku
    ORDER BY sum(l.line_total_cents - l.discount_cents) DESC
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
