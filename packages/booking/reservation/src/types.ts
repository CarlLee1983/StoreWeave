import { z } from 'zod';
import { bookingQuoteInputSchema, bookingQuoteSchema } from '@storeweave/booking-availability';
import {
  paymentInitiationInputSchema,
  paymentInitiationResultSchema,
  paymentRefundInputSchema,
} from '@storeweave/extension-sdk';

const quoteFingerprintSchema = bookingQuoteSchema.shape.fingerprint;

export const bookingQuoteSubmissionSchema = bookingQuoteInputSchema.extend({
  fingerprint: quoteFingerprintSchema,
}).strict();

export const bookerInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(40),
}).strict();

export const createBookingReservationInputSchema = z.object({
  quote: bookingQuoteSubmissionSchema,
  booker: bookerInputSchema,
  primaryGuestName: z.string().trim().min(1).max(160),
  accommodationNotes: z.string().trim().max(2000).optional(),
}).strict();

export const bookingReservationCreatedSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('pending_payment'),
  paymentExpiresAt: z.string().datetime(),
  quote: bookingQuoteSchema,
}).strict();

export const createBookingReservationOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), reservation: bookingReservationCreatedSchema }).strict(),
  z.object({ kind: z.literal('stale'), replacementQuote: bookingQuoteSchema }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);

export const expireBookingReservationInputSchema = z.object({
  reservationId: z.string().uuid(),
  expectedPaymentExpiresAt: z.string().datetime(),
}).strict();

export const expireBookingReservationOutputSchema = z.object({
  kind: z.enum(['expired', 'noop']),
}).strict();

export const BOOKING_RESERVATION_PAYMENT_ATTEMPT_STATUSES = [
  'created', 'submitted', 'awaiting_payment', 'succeeded', 'failed', 'expired',
] as const;

export const BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES = [
  'created', 'submitted', 'awaiting_payment',
] as const;

export const bookingReservationPaymentAttemptStatusSchema = z.enum(BOOKING_RESERVATION_PAYMENT_ATTEMPT_STATUSES);
export const bookingReservationPaymentSuccessKindSchema = z.enum(['winning', 'late', 'excess']);

export const startBookingReservationPaymentInputSchema = z.object({
  reservationId: z.string().uuid(),
  method: z.string().trim().min(1).max(100),
}).strict();

export const bookingReservationPaymentAttemptSchema = z.object({
  id: z.string().uuid(),
  reservationId: z.string().uuid(),
  reference: z.string().min(1).max(200),
  provider: z.string().min(1).max(200),
  method: z.string().min(1).max(100),
  amountMinor: z.number().safe().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: bookingReservationPaymentAttemptStatusSchema,
  providerRef: z.string().min(1).max(200).nullable(),
  expiresAt: z.string().datetime(),
}).strict();

export const startBookingReservationPaymentOutputSchema = z.object({
  attempt: bookingReservationPaymentAttemptSchema,
}).strict();

export const recordBookingReservationPaymentResultInputSchema = z.object({
  attemptId: z.string().uuid(),
  provider: z.string().min(1).max(200),
  result: paymentInitiationResultSchema,
}).strict();

export const recordBookingReservationPaymentResultOutputSchema = z.object({
  attempt: bookingReservationPaymentAttemptSchema,
}).strict();

export const verifiedBookingPaymentOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payment_confirmed'), reference: z.string().min(1).max(200), providerRef: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('payment_info_issued'), reference: z.string().min(1).max(200), providerRef: z.string().min(1).max(200), instructions: z.array(z.object({ label: z.string(), value: z.string() }).strict()), expiresAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal('payment_failed'), reference: z.string().min(1).max(200), providerRef: z.string().min(1).max(200).optional(), message: z.string().min(1).max(2000).optional() }).strict(),
]);

export const recordVerifiedBookingPaymentOutcomeInputSchema = z.object({
  provider: z.string().min(1).max(200),
  event: verifiedBookingPaymentOutcomeSchema,
}).strict();

export const recordVerifiedBookingPaymentOutcomeOutputSchema = recordBookingReservationPaymentResultOutputSchema;

export const getBookingReservationPaymentAttemptForProcessingInputSchema = z.object({
  attemptId: z.string().uuid(),
  provider: z.string().min(1).max(200),
  reference: z.string().min(1).max(200),
}).strict();

export const getBookingReservationPaymentAttemptForProcessingOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noop') }).strict(),
  z.object({ kind: z.literal('invoke'), request: paymentInitiationInputSchema }).strict(),
]);

export const bookingReservationRefundStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export const bookingReservationRefundReasonSchema = z.enum(['late_payment', 'excess_payment', 'reservation_cancellation']);
export const requiredBookingReservationRefundReasonSchema = z.enum(['late_payment', 'excess_payment']);
export const bookingReservationRefundSchema = z.object({
  id: z.string().uuid(), reservationId: z.string().uuid(), paymentAttemptId: z.string().uuid(),
  reason: bookingReservationRefundReasonSchema, provider: z.string().min(1).max(200),
  paymentProviderRef: z.string().min(1).max(200), amountMinor: z.number().safe().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/), providerRequestRef: z.string().min(1).max(200),
  status: bookingReservationRefundStatusSchema, generation: z.number().safe().int().positive(),
  providerRefundRef: z.string().nullable(), failureKind: z.enum(['rejected', 'unsupported', 'indeterminate']).nullable(),
  failureMessage: z.string().nullable(), requestedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export const requestRequiredBookingReservationRefundInputSchema = z.object({
  reservationId: z.string().uuid(), paymentAttemptId: z.string().uuid(), reason: requiredBookingReservationRefundReasonSchema,
}).strict();
export const requestRequiredBookingReservationRefundOutputSchema = z.object({ refund: bookingReservationRefundSchema }).strict();

export const getBookingReservationRefundForProcessingInputSchema = z.object({
  refundId: z.string().uuid(), generation: z.number().safe().int().positive(),
}).strict();
export const getBookingReservationRefundForProcessingOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noop') }).strict(),
  z.object({ kind: z.literal('invoke'), provider: z.string().min(1).max(200), workerAttempt: z.number().safe().int().positive(), request: paymentRefundInputSchema }).strict(),
]);

export const recordBookingReservationRefundInvocationInputSchema = z.object({
  refundId: z.string().uuid(), generation: z.number().safe().int().positive(), workerAttempt: z.number().safe().int().positive(),
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('succeeded'), providerRefundRef: z.string().min(1).max(200) }).strict(),
    z.object({ status: z.literal('rejected'), message: z.string().min(1).max(2000) }).strict(),
    z.object({ status: z.literal('unsupported'), message: z.string().min(1).max(2000) }).strict(),
    z.object({ status: z.literal('indeterminate'), message: z.string().min(1).max(2000), final: z.boolean().optional() }).strict(),
  ]),
}).strict();
export const recordBookingReservationRefundInvocationOutputSchema = z.object({ refund: bookingReservationRefundSchema }).strict();
export const retryBookingReservationRefundInputSchema = z.object({ refundId: z.string().uuid() }).strict();
export const retryBookingReservationRefundOutputSchema = requestRequiredBookingReservationRefundOutputSchema;
export const listBookingReservationRefundsInputSchema = z.object({ reservationId: z.string().uuid() }).strict();
export const listBookingReservationRefundsOutputSchema = z.object({ items: z.array(bookingReservationRefundSchema) }).strict();

export const claimBookingReservationInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128),
}).strict();

export const claimBookingReservationOutputSchema = z.object({
  reservationId: z.string().uuid(),
  kind: z.enum(['claimed', 'already-owner']),
}).strict();

export const getOwnedBookingReservationInputSchema = z.object({
  reservationId: z.string().uuid(),
}).strict();

export const getManagedBookingReservationInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128),
}).strict();

export const managedBookingReservationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending_payment', 'confirmed', 'expired', 'cancelled']),
  paymentExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  booker: z.object({
    name: z.string().min(1).max(160).nullable(),
    email: z.string().email().max(320).nullable(),
    phone: z.string().min(1).max(40).nullable(),
  }).strict(),
  primaryGuestName: z.string().min(1).max(160).nullable(),
  accommodationNotes: z.string().max(2000).nullable(),
  quote: bookingQuoteSchema,
}).strict();

export const getOwnedBookingReservationOutputSchema = z.object({
  reservation: managedBookingReservationSchema,
}).strict();

export const getManagedBookingReservationOutputSchema = getOwnedBookingReservationOutputSchema;

export const updateBookingReservationDetailsInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128).optional(),
  booker: bookerInputSchema.optional(),
  primaryGuestName: z.string().trim().min(1).max(160).optional(),
  accommodationNotes: z.string().trim().max(2000).nullable().optional(),
}).strict().refine(
  input => input.booker !== undefined || input.primaryGuestName !== undefined || input.accommodationNotes !== undefined,
  'At least one Booker, Guest, or notes field must be updated',
);

export const updateBookingReservationDetailsOutputSchema = z.object({
  reservationId: z.string().uuid(),
  updatedFields: z.array(z.enum(['booker', 'primaryGuestName', 'accommodationNotes'])).min(1),
}).strict();

export type BookingQuoteSubmission = z.infer<typeof bookingQuoteSubmissionSchema>;
export type CreateBookingReservationInput = z.infer<typeof createBookingReservationInputSchema>;
export type CreateBookingReservationOutput = z.infer<typeof createBookingReservationOutputSchema>;
export type ExpireBookingReservationInput = z.infer<typeof expireBookingReservationInputSchema>;
export type BookingReservationPaymentAttempt = z.infer<typeof bookingReservationPaymentAttemptSchema>;
export type StartBookingReservationPaymentInput = z.infer<typeof startBookingReservationPaymentInputSchema>;
export type StartBookingReservationPaymentOutput = z.infer<typeof startBookingReservationPaymentOutputSchema>;
export type RecordBookingReservationPaymentResultInput = z.infer<typeof recordBookingReservationPaymentResultInputSchema>;
export type RecordVerifiedBookingPaymentOutcomeInput = z.infer<typeof recordVerifiedBookingPaymentOutcomeInputSchema>;
export type GetBookingReservationPaymentAttemptForProcessingInput = z.infer<typeof getBookingReservationPaymentAttemptForProcessingInputSchema>;
export type BookingReservationRefund = z.infer<typeof bookingReservationRefundSchema>;
export type RequestRequiredBookingReservationRefundInput = z.infer<typeof requestRequiredBookingReservationRefundInputSchema>;
export type GetBookingReservationRefundForProcessingInput = z.infer<typeof getBookingReservationRefundForProcessingInputSchema>;
export type RecordBookingReservationRefundInvocationInput = z.infer<typeof recordBookingReservationRefundInvocationInputSchema>;
export type RetryBookingReservationRefundInput = z.infer<typeof retryBookingReservationRefundInputSchema>;
export type ListBookingReservationRefundsInput = z.infer<typeof listBookingReservationRefundsInputSchema>;
export type ClaimBookingReservationInput = z.infer<typeof claimBookingReservationInputSchema>;
export type ClaimBookingReservationOutput = z.infer<typeof claimBookingReservationOutputSchema>;
export type GetOwnedBookingReservationInput = z.infer<typeof getOwnedBookingReservationInputSchema>;
export type GetManagedBookingReservationInput = z.infer<typeof getManagedBookingReservationInputSchema>;
export type ManagedBookingReservation = z.infer<typeof managedBookingReservationSchema>;
export type UpdateBookingReservationDetailsInput = z.infer<typeof updateBookingReservationDetailsInputSchema>;
export type UpdateBookingReservationDetailsOutput = z.infer<typeof updateBookingReservationDetailsOutputSchema>;
