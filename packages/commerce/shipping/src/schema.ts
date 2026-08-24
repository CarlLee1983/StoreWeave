import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Merchant-maintained customer-facing delivery choices. Fees are business policy, not provider quotes. */
export const shippingMethods = pgTable('shipping_methods', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  destinationKind: text('destination_kind').notNull(),
  feeCents: integer('fee_cents').notNull(),
  freeShippingThresholdCents: integer('free_shipping_threshold_cents'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A shipment belongs to shipping, not order. `orderId` intentionally has no foreign key:
 * it is a cross-module reference and its integrity is enforced by the calling service.
 */
export const shipments = pgTable('shipping_shipments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  shippingMethodId: uuid('shipping_method_id').notNull().references(() => shippingMethods.id),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  providerRef: text('provider_ref'),
  trackingNumber: text('tracking_number'),
  status: text('status').notNull().default('created'),
  /** Provider-specific state is operational evidence, never a public event or DTO field. */
  providerStatusRaw: text('provider_status_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ShippingMethodRow = typeof shippingMethods.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
