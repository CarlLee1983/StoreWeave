import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const orders = pgTable('order_orders', {
  id: uuid('id').primaryKey(),
  number: text('number').notNull().unique(),
  status: text('status').notNull().default('pending'),
  currency: text('currency').notNull(),
  customerEmail: text('customer_email').notNull(),
  subtotalCents: integer('subtotal_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  shippingCents: integer('shipping_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  metadata: jsonb('metadata'),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orderLines = pgTable('order_lines', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id').notNull(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  quantity: integer('quantity').notNull(),
  lineTotalCents: integer('line_total_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
});

export const orderPayments = pgTable('order_payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  provider: text('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
