import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** An RMA is the auditable return decision; financial settlement remains Refund's fact. */
export const rmas = pgTable('rma_cases', {
  id: uuid('id').primaryKey(), orderId: uuid('order_id').notNull(), customerId: uuid('customer_id').notNull(),
  status: text('status').notNull().default('requested'), resolution: text('resolution').notNull().default('refund_and_reorder'),
  reason: text('reason').notNull(), requestedByActorId: text('requested_by_actor_id').notNull(), staffNote: text('staff_note'),
  refundId: uuid('refund_id'), receivedAt: timestamp('received_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const rmaLines = pgTable('rma_lines', {
  id: uuid('id').primaryKey(), rmaId: uuid('rma_id').notNull(), orderLineId: uuid('order_line_id').notNull(), productId: uuid('product_id').notNull(),
  sku: text('sku').notNull(), name: text('name').notNull(), unitPriceCents: integer('unit_price_cents').notNull(), lineTotalCents: integer('line_total_cents').notNull(), discountCents: integer('discount_cents').notNull().default(0), quantity: integer('quantity').notNull(),
  disposition: text('disposition'), discardReason: text('discard_reason'),
});
export type RmaRow = typeof rmas.$inferSelect;
export type RmaLineRow = typeof rmaLines.$inferSelect;
