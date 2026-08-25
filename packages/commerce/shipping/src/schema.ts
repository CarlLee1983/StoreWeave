import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  /** Frozen order-delivery data for the carrier adapter; old/manual rows may not have it. */
  serviceCode: text('service_code'),
  destinationSnapshot: jsonb('destination_snapshot').$type<unknown>(),
  /** Platform-assigned idempotency reference, distinct from the carrier's providerRef. */
  providerRequestRef: text('provider_request_ref'),
  /** Extension id authorised to read this shipment's carrier request; null keeps manual/legacy data core-only. */
  providerOwner: text('provider_owner'),
  providerRef: text('provider_ref'),
  trackingNumber: text('tracking_number'),
  /** Provider-supplied, validated customer tracking page; never a label/download URL. */
  trackingUrl: text('tracking_url'),
  /** Opaque carrier label handle; never a URL, signed credential, or label payload. */
  labelReference: text('label_reference'),
  status: text('status').notNull().default('created'),
  /** Provider-specific state is operational evidence, never a public event or DTO field. */
  providerStatusRaw: text('provider_status_raw'),
  /** Lossless base64 of the latest verified callback body; restricted operational evidence only. */
  providerCallbackRaw: text('provider_callback_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Hash-only, short-lived capability used to bring an external picker result back to one cart. */
export const pickupSelections = pgTable('shipping_pickup_selections', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  cartId: uuid('cart_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  shippingMethodId: uuid('shipping_method_id').notNull().references(() => shippingMethods.id),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  providerStoreId: text('provider_store_id'),
  storeName: text('store_name'),
  storeAddress: text('store_address'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ShippingMethodRow = typeof shippingMethods.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type PickupSelectionRow = typeof pickupSelections.$inferSelect;
