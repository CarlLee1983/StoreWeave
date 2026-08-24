import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const orders = pgTable('order_orders', {
  id: uuid('id').primaryKey(),
  number: text('number').notNull().unique(),
  status: text('status').notNull().default('pending'),
  currency: text('currency').notNull(),
  customerEmail: text('customer_email').notNull(),
  /** 下單者。歷史訂單沒有這個欄位，因此可為 null。 */
  customerId: uuid('customer_id'),
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

/** 這張訂單套用了哪些活動、各折多少。它同時是行銷分析的事實來源之一。 */
export const orderAdjustments = pgTable('order_adjustments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  sourceId: text('source_id').notNull(),
  name: text('name').notNull(),
  /** 折扣為負數，與 Adjustment 的定義一致。 */
  amountCents: integer('amount_cents').notNull(),
  /** 套用順序，重播時才知道當時的先後。 */
  sortOrder: integer('sort_order').notNull(),
});

export const orderPayments = pgTable('order_payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  /** 平台自己的付款嘗試識別；provider callback 只能拿它回來找同一筆嘗試。 */
  attemptRef: text('attempt_ref').notNull().unique(),
  provider: text('provider').notNull(),
  method: text('method').notNull(),
  /** Provider 可能在啟動失敗前就沒有配置外部交易號，因此允許空值。 */
  providerRef: text('provider_ref'),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').notNull(),
  /** 導轉／表單送出動作由平台持久化，不能在 worker 記憶體裡等顧客回來。 */
  action: jsonb('action'),
  instructions: jsonb('instructions'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  failureMessage: text('failure_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Checkout freezes the customer-facing delivery choice here. It deliberately
 * references shipping by value instead of a cross-module FK: the order must
 * remain readable even after a merchant retires or renames that method.
 */
export const orderDeliveries = pgTable('order_deliveries', {
  orderId: uuid('order_id').primaryKey().references(() => orders.id, { onDelete: 'cascade' }),
  shippingMethodId: uuid('shipping_method_id').notNull(),
  shippingMethodCode: text('shipping_method_code').notNull(),
  shippingMethodName: text('shipping_method_name').notNull(),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  destinationKind: text('destination_kind').notNull(),
  recipient: text('recipient').notNull(),
  phone: text('phone').notNull(),
  countryCode: text('country_code'),
  postcode: text('postcode'),
  city: text('city'),
  district: text('district'),
  line1: text('line1'),
  line2: text('line2'),
  providerStoreId: text('provider_store_id'),
  storeName: text('store_name'),
  storeAddress: text('store_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
export type OrderAdjustmentRow = typeof orderAdjustments.$inferSelect;
export type OrderPaymentRow = typeof orderPayments.$inferSelect;
export type OrderDeliveryRow = typeof orderDeliveries.$inferSelect;
