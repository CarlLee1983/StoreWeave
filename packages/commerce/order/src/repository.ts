import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { orderAdjustments, orderLines, orders, type OrderAdjustmentRow, type OrderLineRow, type OrderRow } from './schema';
import type { OrderDto } from './dto';

/**
 * `adjustments` 是必填的：預設空陣列會讓「這張單沒有折扣」與「這裡沒去載」
 * 在契約上長得一模一樣，付款、取消、逾時那幾條路徑就會安靜地少回折扣明細。
 */
export function toOrderDto(row: OrderRow, lines: OrderLineRow[], adjustments: OrderAdjustmentRow[]): OrderDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status as OrderDto['status'],
    currency: row.currency,
    customerEmail: row.customerEmail,
    customerId: row.customerId,
    subtotalCents: row.subtotalCents,
    totalCents: row.totalCents,
    discountCents: row.discountCents,
    shippingCents: row.shippingCents,
    taxCents: row.taxCents,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      sku: l.sku,
      name: l.name,
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
      lineTotalCents: l.lineTotalCents,
      discountCents: l.discountCents,
    })),
    adjustments: adjustments.map((a) => ({
      source: a.source as 'promotion',
      sourceId: a.sourceId,
      name: a.name,
      amountCents: a.amountCents,
    })),
    placedAt: row.placedAt,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    expiresAt: row.expiresAt,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

export class OrderRepository {
  async nextOrderNumber(tx: Tx, prefix: string): Promise<string> {
    const res = await tx.execute<{ n: string }>(sql`SELECT nextval('order_number_seq')::text AS n`);
    return `${prefix}-${res.rows[0].n}`;
  }

  async lockById(tx: Tx, id: string): Promise<OrderRow | null> {
    const res = await tx.execute<Record<string, any>>(sql`SELECT * FROM order_orders WHERE id = ${id} FOR UPDATE`);
    const r = res.rows[0];
    if (!r) return null;
    return mapOrderRow(r);
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row ?? null;
  }

  async findByNumber(db: DrizzleDb | Tx, number: string): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders).where(eq(orders.number, number)).limit(1);
    return row ?? null;
  }

  async adjustmentsFor(db: DrizzleDb | Tx, orderId: string): Promise<OrderAdjustmentRow[]> {
    return db
      .select()
      .from(orderAdjustments)
      .where(eq(orderAdjustments.orderId, orderId))
      .orderBy(orderAdjustments.sortOrder);
  }

  /** 固定排序：事件的 lines 順序決定下游的行號，不能每次重送都不一樣。 */
  async linesFor(db: DrizzleDb | Tx, orderId: string): Promise<OrderLineRow[]> {
    return db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.id);
  }

  async list(db: DrizzleDb, filter: { status?: string; customerEmail?: string; limit: number; offset: number }) {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(orders.status, filter.status));
    if (filter.customerEmail) conditions.push(eq(orders.customerEmail, filter.customerEmail));
    const where = conditions.length ? and(...conditions)! : sql`true`;
    const rows = await db.select().from(orders).where(where).orderBy(desc(orders.placedAt)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(where);
    return { rows, total: Number(count) };
  }
}

function mapOrderRow(r: Record<string, any>): OrderRow {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    currency: r.currency,
    customerEmail: r.customer_email,
    customerId: r.customer_id ?? null,
    subtotalCents: r.subtotal_cents,
    totalCents: r.total_cents,
    discountCents: r.discount_cents,
    shippingCents: r.shipping_cents,
    taxCents: r.tax_cents,
    metadata: r.metadata,
    placedAt: r.placed_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    // Raw `tx.execute` rows expose timestamptz as strings, unlike Drizzle selects.
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    updatedAt: r.updated_at,
  };
}
