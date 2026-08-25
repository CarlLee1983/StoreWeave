import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Durable, operator-visible evidence of one event/template notification. */
export const lifecycleDeliveries = pgTable('notification_lifecycle_deliveries', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull(),
  orderId: uuid('order_id').notNull(),
  template: text('template').notNull(),
  /** Stable idempotency reference supplied to the provider on every retry. */
  reference: text('reference').notNull().unique(),
  recipientEmail: text('recipient_email').notNull(),
  variables: jsonb('variables').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  providerRef: text('provider_ref'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LifecycleDeliveryRow = typeof lifecycleDeliveries.$inferSelect;
