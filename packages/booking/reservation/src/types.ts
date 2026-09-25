import { z } from 'zod';
import { bookingQuoteInputSchema, bookingQuoteSchema } from '@storeweave/booking-availability';
import {
  paymentInitiationInputSchema,
  paymentInitiationResultSchema,
  paymentRefundInputSchema,
} from '@storeweave/extension-sdk';
import { deliveryEvidenceDto } from '@storeweave/notifications';

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

const bookingReservationCancellationResultSchema = z.object({
  reservationId: z.string().uuid(),
  cancelled: z.literal(true),
  refund: z.object({ id: z.string().uuid(), amountMinor: z.number().safe().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict().nullable(),
}).strict();

export const cancelBookingReservationSelfInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128).optional(),
}).strict();
export const cancelBookingReservationSelfOutputSchema = bookingReservationCancellationResultSchema;

export const cancelBookingReservationByOperatorInputSchema = z.object({
  reservationId: z.string().uuid(),
  refundAmountMinor: z.number().safe().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const cancelBookingReservationByOperatorOutputSchema = bookingReservationCancellationResultSchema;

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
  // Missing/malformed bearer material is normalized by the public adapter and
  // rejected by checkout authorization, so it cannot become a validation oracle.
  checkoutCredential: z.string().max(256).optional().default(''),
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
export const listBookingReservationRefundsInputSchema = z.object({
  reservationId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();
export const operatorBookingReservationRefundSchema = bookingReservationRefundSchema.pick({
  id: true, reservationId: true, paymentAttemptId: true, reason: true, provider: true,
  paymentProviderRef: true, amountMinor: true, currency: true, providerRequestRef: true,
  status: true, generation: true, providerRefundRef: true, failureKind: true,
  requestedAt: true, completedAt: true, updatedAt: true,
});
export const listBookingReservationRefundsOutputSchema = z.object({
  items: z.array(operatorBookingReservationRefundSchema), total: z.number().int().nonnegative(),
}).strict();

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

/**
 * The management credential is supplied only by a trusted server adapter from
 * its secure session state. An absent credential means the current Account
 * must own the Reservation.
 */
export const resendBookingReservationAccessGrantInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128).optional(),
}).strict();

export const resendBookingReservationAccessGrantOutputSchema = z.object({
  reservationId: z.string().uuid(),
  accepted: z.literal(true),
}).strict();

export const bookingReservationNotificationKindSchema = z.enum(['confirmed', 'cancelled', 'payment-expiring', 'late-payment']);
export type BookingReservationNotificationKind = z.infer<typeof bookingReservationNotificationKindSchema>;

export const bookingReservationNotificationTemplateIdSchema = z.enum([
  'booking.reservation.confirmed',
  'booking.reservation.cancelled',
  'booking.reservation.payment-expiring',
  'booking.reservation.late-payment',
]);
export type BookingReservationNotificationTemplateId = z.infer<typeof bookingReservationNotificationTemplateIdSchema>;

const notificationEventBaseSchema = z.object({
  eventId: z.string().uuid(), reservationId: z.string().uuid(),
}).strict();

export const materializeBookingReservationNotificationInputSchema = z.discriminatedUnion('kind', [
  notificationEventBaseSchema.extend({
    kind: z.literal('confirmed'), paymentAttemptId: z.string().uuid(), confirmedAt: z.string().datetime(),
  }).strict(),
  notificationEventBaseSchema.extend({
    kind: z.literal('cancelled'), cancelledAt: z.string().datetime(),
  }).strict(),
  notificationEventBaseSchema.extend({
    kind: z.literal('payment-expiring'), paymentAttemptId: z.string().uuid(), expiresAt: z.string().datetime(),
  }).strict(),
  notificationEventBaseSchema.extend({
    kind: z.literal('late-payment'), paymentAttemptId: z.string().uuid(), refundId: z.string().uuid(),
  }).strict(),
]);

export const bookingReservationNotificationMappingStatusSchema = z.enum([
  'pending', 'requested', 'mapping_failed', 'mapping_retryable', 'superseded',
]);
export const bookingReservationNotificationMappingFailureCodeSchema = z.enum([
  'booker_unavailable', 'late_evidence_invalid', 'materialization_retryable',
]);

const bookingReservationNotificationLinkBaseSchema = z.object({
  id: z.string().uuid(), reservationId: z.string().uuid(), eventId: z.string().uuid(),
  kind: bookingReservationNotificationKindSchema, templateId: bookingReservationNotificationTemplateIdSchema,
  paymentAttemptId: z.string().uuid().nullable().default(null), refundId: z.string().uuid().nullable().default(null),
  reference: z.string().min(1).max(240), mappingStatus: bookingReservationNotificationMappingStatusSchema,
  mappingFailureCode: bookingReservationNotificationMappingFailureCodeSchema.nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const bookingReservationNotificationLinkSchema = bookingReservationNotificationLinkBaseSchema.superRefine((value, context) => {
  const validCode = value.mappingStatus === 'mapping_failed'
    ? value.mappingFailureCode === 'booker_unavailable' || value.mappingFailureCode === 'late_evidence_invalid'
    : value.mappingStatus === 'mapping_retryable'
      ? value.mappingFailureCode === 'materialization_retryable' : value.mappingFailureCode === null;
  if (!validCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mappingFailureCode'], message: 'mapping failure code must match mapping status' });
  }
  if ((value.kind === 'late-payment') !== (value.paymentAttemptId !== null && value.refundId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentAttemptId'], message: 'Late Payment links require Attempt and refund correlation' });
  }
});

export const materializeBookingReservationNotificationOutputSchema = bookingReservationNotificationLinkSchema;
export const recordBookingReservationNotificationMappingFailureInputSchema = z.object({
  eventId: z.string().uuid(), reservationId: z.string().uuid(), kind: bookingReservationNotificationKindSchema,
  failure: z.enum(['permanent', 'retryable']),
  paymentAttemptId: z.string().uuid().optional(), refundId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'late-payment' && (!value.paymentAttemptId || !value.refundId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Late Payment failure evidence requires Attempt and refund IDs' });
  }
});
export const recordBookingReservationNotificationMappingFailureOutputSchema = bookingReservationNotificationLinkSchema;

export const listBookingReservationNotificationsInputSchema = z.object({
  reservationId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10_000).default(0),
}).strict();
export const operatorBookingNotificationDeliverySchema = deliveryEvidenceDto.pick({
  id: true, notificationId: true, templateId: true, templateVersion: true,
  channel: true, status: true, attempts: true, recipientMasked: true,
  sentAt: true, createdAt: true, updatedAt: true,
});
export const bookingReservationNotificationEvidenceSchema = bookingReservationNotificationLinkBaseSchema.extend({
  deliveries: z.array(operatorBookingNotificationDeliverySchema),
}).strict().superRefine((value, context) => {
  const validCode = value.mappingStatus === 'mapping_failed'
    ? value.mappingFailureCode === 'booker_unavailable' || value.mappingFailureCode === 'late_evidence_invalid'
    : value.mappingStatus === 'mapping_retryable'
      ? value.mappingFailureCode === 'materialization_retryable' : value.mappingFailureCode === null;
  if (!validCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mappingFailureCode'], message: 'mapping failure code must match mapping status' });
  }
});
export const listBookingReservationNotificationsOutputSchema = z.object({
  items: z.array(bookingReservationNotificationEvidenceSchema), total: z.number().int().nonnegative(),
}).strict();

export type BookingQuoteSubmission = z.infer<typeof bookingQuoteSubmissionSchema>;
export type CreateBookingReservationInput = z.infer<typeof createBookingReservationInputSchema>;
export type CreateBookingReservationOutput = z.infer<typeof createBookingReservationOutputSchema>;
export type ExpireBookingReservationInput = z.infer<typeof expireBookingReservationInputSchema>;
export type CancelBookingReservationSelfInput = z.infer<typeof cancelBookingReservationSelfInputSchema>;
export type CancelBookingReservationByOperatorInput = z.infer<typeof cancelBookingReservationByOperatorInputSchema>;
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
export type ResendBookingReservationAccessGrantInput = z.infer<typeof resendBookingReservationAccessGrantInputSchema>;
export type ResendBookingReservationAccessGrantOutput = z.infer<typeof resendBookingReservationAccessGrantOutputSchema>;
export type MaterializeBookingReservationNotificationInput = z.infer<typeof materializeBookingReservationNotificationInputSchema>;
export type BookingReservationNotificationLink = z.infer<typeof bookingReservationNotificationLinkSchema>;
export type ListBookingReservationNotificationsInput = z.infer<typeof listBookingReservationNotificationsInputSchema>;
