import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Independent financial facts; a paid order never gets relabelled as cancelled. */
export const refunds = pgTable('refund_refunds', {
  id: uuid('id').primaryKey(), orderId: uuid('order_id').notNull(), customerId: uuid('customer_id'),
  source: text('source').notNull().default('direct'), sourceRef: uuid('source_ref'), originalPaymentAttemptId: uuid('original_payment_attempt_id').notNull(),
  originalPaymentAttemptRef: text('original_payment_attempt_ref').notNull(), paymentProvider: text('payment_provider').notNull(),
  paymentProviderRef: text('payment_provider_ref').notNull(), amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  reason: text('reason').notNull(), requestedByActorId: text('requested_by_actor_id').notNull(), status: text('status').notNull().default('requested'),
  attemptNo: integer('attempt_no').notNull().default(1), providerRequestRef: text('provider_request_ref').notNull().unique(),
  providerRefundRef: text('provider_refund_ref'), failureMessage: text('failure_message'), requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type RefundRow = typeof refunds.$inferSelect;
