import { bigint, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BookingQuote } from '@storeweave/booking-availability';
import type { PaymentInitiationResult } from '@storeweave/extension-sdk';

export const bookingReservationReservations = pgTable('booking_reservation_reservations', {
  id: uuid('id').primaryKey(),
  roomTypeId: uuid('room_type_id').notNull(),
  checkInLocalDate: date('check_in_local_date', { mode: 'string' }).notNull(),
  checkOutLocalDate: date('check_out_local_date', { mode: 'string' }).notNull(),
  roomCount: integer('room_count').notNull(),
  adults: integer('adults').notNull(),
  children: integer('children').notNull(),
  bookerName: text('booker_name'),
  bookerEmail: text('booker_email'),
  bookerPhone: text('booker_phone'),
  primaryGuestName: text('primary_guest_name'),
  accommodationNotes: text('accommodation_notes'),
  status: text('status').notNull().default('pending_payment'),
  paymentExpiresAt: timestamp('payment_expires_at', { withTimezone: true }).notNull(),
  currency: text('currency').notNull(),
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
  nightlyPrices: jsonb('nightly_prices').$type<BookingQuote['nights']>().notNull(),
  cancellationPolicy: jsonb('cancellation_policy').$type<BookingQuote['cancellationPolicy']>().notNull(),
  quoteFingerprint: text('quote_fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  accessGeneration: integer('access_generation').notNull().default(0),
  accessGrantNonce: uuid('access_grant_nonce'),
  accessGrantExpiresAt: timestamp('access_grant_expires_at', { withTimezone: true }),
  accessGrantUsedAt: timestamp('access_grant_used_at', { withTimezone: true }),
  managementTokenHash: text('management_token_hash'),
  checkoutCredentialKeyId: text('checkout_credential_key_id'),
  checkoutCredentialNonce: uuid('checkout_credential_nonce'),
  checkoutCredentialHash: text('checkout_credential_hash'),
  checkoutCredentialExpiresAt: timestamp('checkout_credential_expires_at', { withTimezone: true }),
  checkoutCredentialRevokedAt: timestamp('checkout_credential_revoked_at', { withTimezone: true }),
  ownerAccountId: uuid('owner_account_id'),
  piiAnonymizedAt: timestamp('pii_anonymized_at', { withTimezone: true }),
  winningPaymentAttemptId: uuid('winning_payment_attempt_id'),
}, table => [
  check('booking_reservation_status_check', sql`${table.status} IN ('pending_payment', 'confirmed', 'expired', 'cancelled')`),
  check('booking_reservation_dates_check', sql`${table.checkOutLocalDate} > ${table.checkInLocalDate}`),
  check('booking_reservation_room_count_check', sql`${table.roomCount} > 0`),
  check('booking_reservation_adults_check', sql`${table.adults} >= 0`),
  check('booking_reservation_children_check', sql`${table.children} >= 0`),
  check('booking_reservation_booker_name_check', sql`${table.bookerName} IS NULL OR length(${table.bookerName}) BETWEEN 1 AND 160`),
  check('booking_reservation_booker_email_check', sql`${table.bookerEmail} IS NULL OR length(${table.bookerEmail}) BETWEEN 3 AND 320`),
  check('booking_reservation_booker_phone_check', sql`${table.bookerPhone} IS NULL OR length(${table.bookerPhone}) BETWEEN 1 AND 40`),
  check('booking_reservation_primary_guest_name_check', sql`${table.primaryGuestName} IS NULL OR length(${table.primaryGuestName}) BETWEEN 1 AND 160`),
  check('booking_reservation_notes_check', sql`${table.accommodationNotes} IS NULL OR length(${table.accommodationNotes}) <= 2000`),
  check('booking_reservation_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check('booking_reservation_total_check', sql`${table.totalMinor} >= 0`),
  check('booking_reservation_nightly_prices_check', sql`jsonb_typeof(${table.nightlyPrices}) = 'array'`),
  check('booking_reservation_cancellation_policy_check', sql`jsonb_typeof(${table.cancellationPolicy}) = 'object'`),
  check('booking_reservation_quote_fingerprint_check', sql`${table.quoteFingerprint} ~ '^booking-quote-v1:[a-z][a-z0-9-]{0,63}:[0-9a-f]{64}$'`),
  check('booking_reservation_access_generation_check', sql`${table.accessGeneration} >= 0`),
  check('booking_reservation_access_grant_pair_check', sql`(${table.accessGrantNonce} IS NULL) = (${table.accessGrantExpiresAt} IS NULL)`),
  check('booking_reservation_access_grant_used_check', sql`${table.accessGrantUsedAt} IS NULL OR ${table.accessGrantNonce} IS NOT NULL`),
  check('booking_reservation_management_token_hash_check', sql`${table.managementTokenHash} IS NULL OR (${table.accessGrantUsedAt} IS NOT NULL AND ${table.managementTokenHash} ~ '^[0-9a-f]{64}$')`),
  check('booking_reservation_checkout_credential_pair_check', sql`(${table.checkoutCredentialKeyId} IS NULL) = (${table.checkoutCredentialNonce} IS NULL) AND (${table.checkoutCredentialNonce} IS NULL) = (${table.checkoutCredentialHash} IS NULL) AND (${table.checkoutCredentialHash} IS NULL) = (${table.checkoutCredentialExpiresAt} IS NULL)`),
  check('booking_reservation_checkout_credential_hash_check', sql`${table.checkoutCredentialHash} IS NULL OR ${table.checkoutCredentialHash} ~ '^[0-9a-f]{64}$'`),
  check('booking_reservation_anonymized_state_check', sql`${table.piiAnonymizedAt} IS NULL OR (
    ${table.bookerName} IS NULL AND ${table.bookerEmail} IS NULL AND ${table.bookerPhone} IS NULL
    AND ${table.primaryGuestName} IS NULL AND ${table.accommodationNotes} IS NULL
    AND ${table.ownerAccountId} IS NULL AND ${table.accessGeneration} = 0
    AND ${table.accessGrantNonce} IS NULL AND ${table.accessGrantExpiresAt} IS NULL
    AND ${table.accessGrantUsedAt} IS NULL AND ${table.managementTokenHash} IS NULL
    AND ${table.checkoutCredentialKeyId} IS NULL AND ${table.checkoutCredentialNonce} IS NULL
    AND ${table.checkoutCredentialHash} IS NULL AND ${table.checkoutCredentialExpiresAt} IS NULL
  )`),
  check('booking_reservation_winning_payment_attempt_check', sql`${table.winningPaymentAttemptId} IS NULL OR ${table.status} IN ('confirmed', 'cancelled')`),
  index('booking_reservation_owner_account_idx').on(table.ownerAccountId),
  index('booking_reservation_retention_candidate_idx').on(table.id)
    .where(sql`${table.piiAnonymizedAt} IS NULL`),
]);

export type BookingReservationRow = typeof bookingReservationReservations.$inferSelect;

export const bookingReservationPaymentAttempts = pgTable('booking_reservation_payment_attempts', {
  id: uuid('id').primaryKey(),
  reservationId: uuid('reservation_id').notNull().references(() => bookingReservationReservations.id),
  reference: text('reference').notNull(),
  provider: text('provider').notNull(),
  method: text('method').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('created'),
  providerRef: text('provider_ref'),
  action: jsonb('action').$type<Extract<PaymentInitiationResult, { status: 'redirect' }>['action'] | null>(),
  instructions: jsonb('instructions').$type<Extract<PaymentInitiationResult, { status: 'awaiting_payment' }>['instructions'] | null>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  failureReason: text('failure_reason'),
  failureMessage: text('failure_message'),
  successKind: text('success_kind').$type<'winning' | 'late' | 'excess' | null>(),
  succeededAt: timestamp('succeeded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_reservation_payment_attempt_status_check', sql`${table.status} IN ('created', 'submitted', 'awaiting_payment', 'succeeded', 'failed', 'expired')`),
  check('booking_reservation_payment_attempt_reference_check', sql`length(${table.reference}) BETWEEN 1 AND 200`),
  check('booking_reservation_payment_attempt_provider_check', sql`length(${table.provider}) BETWEEN 1 AND 200`),
  check('booking_reservation_payment_attempt_method_check', sql`length(${table.method}) BETWEEN 1 AND 100`),
  check('booking_reservation_payment_attempt_amount_check', sql`${table.amountMinor} > 0`),
  check('booking_reservation_payment_attempt_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check('booking_reservation_payment_attempt_provider_ref_check', sql`${table.providerRef} IS NULL OR length(${table.providerRef}) BETWEEN 1 AND 200`),
  check('booking_reservation_payment_attempt_success_evidence_check', sql`
    (
      ${table.status} <> 'succeeded'
      AND ${table.successKind} IS NULL
      AND ${table.succeededAt} IS NULL
    ) OR (
      ${table.status} = 'succeeded'
      AND ${table.successKind} IN ('winning', 'late', 'excess')
      AND ${table.succeededAt} IS NOT NULL
      AND ${table.providerRef} IS NOT NULL
    )
  `),
  uniqueIndex('booking_reservation_payment_attempt_reference_key').on(table.reference),
  uniqueIndex('booking_reservation_payment_attempt_provider_ref_key').on(table.provider, table.providerRef)
    .where(sql`${table.providerRef} IS NOT NULL`),
  // This redundant-in-shape key is the SQL parent key for the Refund's
  // composite FK: a Refund cannot point at an Attempt from another Reservation.
  uniqueIndex('booking_reservation_payment_attempt_id_reservation_key').on(table.id, table.reservationId),
  uniqueIndex('booking_reservation_payment_attempt_active_reservation_key').on(table.reservationId)
    .where(sql`${table.status} IN ('created', 'submitted', 'awaiting_payment')`),
  uniqueIndex('booking_reservation_payment_attempt_winning_reservation_key').on(table.reservationId)
    .where(sql`${table.successKind} = 'winning'`),
]);

export type BookingReservationPaymentAttemptRow = typeof bookingReservationPaymentAttempts.$inferSelect;

/** Immutable required-refund header; each refunded received payment owns one. */
export const bookingReservationRefunds = pgTable('booking_reservation_refunds', {
  id: uuid('id').primaryKey(),
  reservationId: uuid('reservation_id').notNull().references(() => bookingReservationReservations.id),
  paymentAttemptId: uuid('payment_attempt_id').notNull().references(() => bookingReservationPaymentAttempts.id),
  reason: text('reason').$type<'late_payment' | 'excess_payment' | 'reservation_cancellation'>().notNull(),
  provider: text('provider').notNull(),
  paymentProviderRef: text('payment_provider_ref').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  providerRequestRef: text('provider_request_ref').notNull(),
  status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
  generation: integer('generation').notNull().default(1),
  providerRefundRef: text('provider_refund_ref'),
  failureKind: text('failure_kind').$type<'rejected' | 'unsupported' | 'indeterminate' | null>(),
  failureMessage: text('failure_message'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_reservation_refund_reason_check', sql`${table.reason} IN ('late_payment', 'excess_payment', 'reservation_cancellation')`),
  check('booking_reservation_refund_amount_check', sql`${table.amountMinor} > 0`),
  check('booking_reservation_refund_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check('booking_reservation_refund_generation_check', sql`${table.generation} >= 1`),
  check('booking_reservation_refund_status_check', sql`${table.status} IN ('pending', 'succeeded', 'failed')`),
  uniqueIndex('booking_reservation_refund_attempt_key').on(table.paymentAttemptId),
  uniqueIndex('booking_reservation_refund_request_key').on(table.providerRequestRef),
  index('booking_reservation_refund_reservation_idx').on(table.reservationId, table.requestedAt),
  foreignKey({
    columns: [table.paymentAttemptId, table.reservationId],
    foreignColumns: [bookingReservationPaymentAttempts.id, bookingReservationPaymentAttempts.reservationId],
    name: 'booking_reservation_refund_attempt_reservation_fk',
  }),
]);
export type BookingReservationRefundRow = typeof bookingReservationRefunds.$inferSelect;

/** Append-only provider invocation evidence; never overwrite an uncertain call. */
export const bookingReservationRefundInvocations = pgTable('booking_reservation_refund_invocations', {
  id: uuid('id').primaryKey(),
  refundId: uuid('refund_id').notNull().references(() => bookingReservationRefunds.id),
  generation: integer('generation').notNull(),
  workerAttempt: integer('worker_attempt').notNull(),
  outcome: text('outcome').$type<'succeeded' | 'rejected' | 'unsupported' | 'indeterminate'>().notNull(),
  providerRefundRef: text('provider_refund_ref'),
  message: text('message'),
  invokedAt: timestamp('invoked_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_reservation_refund_invocation_generation_check', sql`${table.generation} >= 1`),
  check('booking_reservation_refund_invocation_worker_attempt_check', sql`${table.workerAttempt} >= 1`),
  check('booking_reservation_refund_invocation_outcome_check', sql`${table.outcome} IN ('succeeded', 'rejected', 'unsupported', 'indeterminate')`),
  uniqueIndex('booking_reservation_refund_invocation_key').on(table.refundId, table.generation, table.workerAttempt),
]);
export type BookingReservationRefundInvocationRow = typeof bookingReservationRefundInvocations.$inferSelect;

/** Booking's durable correlation to Base delivery evidence; it never copies delivery state. */
export const bookingReservationNotificationLinks = pgTable('booking_reservation_notification_links', {
  id: uuid('id').primaryKey(),
  reservationId: uuid('reservation_id').notNull().references(() => bookingReservationReservations.id),
  eventId: uuid('event_id').notNull(),
  kind: text('kind').$type<'confirmed' | 'cancelled' | 'payment-expiring'>().notNull(),
  templateId: text('template_id').$type<'booking.reservation.confirmed' | 'booking.reservation.cancelled' | 'booking.reservation.payment-expiring'>().notNull(),
  reference: text('reference').notNull(),
  mappingStatus: text('mapping_status').$type<'pending' | 'requested' | 'mapping_failed' | 'mapping_retryable' | 'superseded'>().notNull().default('pending'),
  mappingFailureCode: text('mapping_failure_code').$type<'booker_unavailable' | 'materialization_retryable' | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_reservation_notification_kind_check', sql`${table.kind} IN ('confirmed', 'cancelled', 'payment-expiring')`),
  check('booking_reservation_notification_template_check', sql`${table.templateId} IN ('booking.reservation.confirmed', 'booking.reservation.cancelled', 'booking.reservation.payment-expiring')`),
  check('booking_reservation_notification_mapping_status_check', sql`${table.mappingStatus} IN ('pending', 'requested', 'mapping_failed', 'mapping_retryable', 'superseded')`),
  check('booking_reservation_notification_failure_code_check', sql`
    (${table.mappingStatus} = 'mapping_failed' AND ${table.mappingFailureCode} = 'booker_unavailable')
    OR (${table.mappingStatus} = 'mapping_retryable' AND ${table.mappingFailureCode} = 'materialization_retryable')
    OR (${table.mappingStatus} IN ('pending', 'requested', 'superseded') AND ${table.mappingFailureCode} IS NULL)
  `),
  uniqueIndex('booking_reservation_notification_event_template_key').on(table.eventId, table.templateId),
  uniqueIndex('booking_reservation_notification_reference_key').on(table.reference),
  index('booking_reservation_notification_reservation_idx').on(table.reservationId, table.createdAt),
]);

export type BookingReservationNotificationLinkRow = typeof bookingReservationNotificationLinks.$inferSelect;
