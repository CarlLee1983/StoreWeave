import { bigint, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  ownerAccountId: uuid('owner_account_id'),
  piiAnonymizedAt: timestamp('pii_anonymized_at', { withTimezone: true }),
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
  check('booking_reservation_anonymized_state_check', sql`${table.piiAnonymizedAt} IS NULL OR (
    ${table.bookerName} IS NULL AND ${table.bookerEmail} IS NULL AND ${table.bookerPhone} IS NULL
    AND ${table.primaryGuestName} IS NULL AND ${table.accommodationNotes} IS NULL
    AND ${table.ownerAccountId} IS NULL AND ${table.accessGeneration} = 0
    AND ${table.accessGrantNonce} IS NULL AND ${table.accessGrantExpiresAt} IS NULL
    AND ${table.accessGrantUsedAt} IS NULL AND ${table.managementTokenHash} IS NULL
  )`),
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
  uniqueIndex('booking_reservation_payment_attempt_reference_key').on(table.reference),
  uniqueIndex('booking_reservation_payment_attempt_provider_ref_key').on(table.provider, table.providerRef)
    .where(sql`${table.providerRef} IS NOT NULL`),
  uniqueIndex('booking_reservation_payment_attempt_active_reservation_key').on(table.reservationId)
    .where(sql`${table.status} IN ('created', 'submitted', 'awaiting_payment')`),
]);

export type BookingReservationPaymentAttemptRow = typeof bookingReservationPaymentAttempts.$inferSelect;
