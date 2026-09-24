import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import { BookingReservationRepository } from './repository';
import { PROCESS_BOOKING_RESERVATION_REFUND_JOB } from './jobs';
import { requireBookingReservation, requireBookingReservationOperator } from './operator-read';
import {
  bookingReservationRefundReasonSchema,
  bookingReservationRefundStatusSchema,
  getBookingReservationRefundForProcessingInputSchema,
  getBookingReservationRefundForProcessingOutputSchema,
  listBookingReservationRefundsInputSchema,
  listBookingReservationRefundsOutputSchema,
  recordBookingReservationRefundInvocationInputSchema,
  recordBookingReservationRefundInvocationOutputSchema,
  requestRequiredBookingReservationRefundInputSchema,
  requestRequiredBookingReservationRefundOutputSchema,
  retryBookingReservationRefundInputSchema,
  retryBookingReservationRefundOutputSchema,
  type BookingReservationRefund,
  type GetBookingReservationRefundForProcessingInput,
  type ListBookingReservationRefundsInput,
  type RecordBookingReservationRefundInvocationInput,
  type RequestRequiredBookingReservationRefundInput,
  type RetryBookingReservationRefundInput,
} from './types';

const repository = new BookingReservationRepository();

function toRefund(row: {
  id: string; reservationId: string; paymentAttemptId: string; reason: string; provider: string;
  paymentProviderRef: string; amountMinor: number; currency: string; providerRequestRef: string;
  status: string; generation: number; providerRefundRef: string | null; failureKind: string | null;
  failureMessage: string | null; requestedAt: Date; completedAt: Date | null; updatedAt: Date;
}): BookingReservationRefund {
  return {
    id: row.id, reservationId: row.reservationId, paymentAttemptId: row.paymentAttemptId,
    reason: bookingReservationRefundReasonSchema.parse(row.reason), provider: row.provider,
    paymentProviderRef: row.paymentProviderRef, amountMinor: row.amountMinor, currency: row.currency,
    providerRequestRef: row.providerRequestRef, status: bookingReservationRefundStatusSchema.parse(row.status),
    generation: row.generation, providerRefundRef: row.providerRefundRef,
    failureKind: row.failureKind === null ? null : zFailureKind(row.failureKind), failureMessage: row.failureMessage,
    requestedAt: row.requestedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
function zFailureKind(kind: string): 'rejected' | 'unsupported' | 'indeterminate' {
  if (kind === 'rejected' || kind === 'unsupported' || kind === 'indeterminate') return kind;
  throw new Error(`Invalid persisted Reservation refund failure kind ${kind}`);
}

/**
 * Reservation-local creation seam. It revalidates the immutable received
 * payment under the Reservation-first lock and is safe to call after SW-128
 * has classified a late/excess success in the same transaction.
 */
export async function createRequiredBookingReservationRefund(
  context: CommandContext,
  input: {
    reservationId: string; paymentAttemptId: string;
    reason: 'late_payment' | 'excess_payment' | 'reservation_cancellation';
    /** Cancellation supplies a caller-constrained positive full/partial amount; zero means no provider work. */
    amountMinor?: number;
    /** Callback replay/backfill repair may return the matching header; a new command may not. */
    allowExisting?: boolean;
  },
) {
  const reservation = await repository.lockById(context.tx, input.reservationId);
  if (!reservation) throw PlatformError.notFound('Reservation', input.reservationId);
  const attempts = await repository.lockPaymentAttemptsForReservation(context.tx, reservation.id);
  const attempt = attempts.find(candidate => candidate.id === input.paymentAttemptId);
  if (!attempt) throw PlatformError.notFound('Reservation payment attempt', input.paymentAttemptId);
  const requiredSuccessKind = input.reason === 'late_payment' ? 'late'
    : input.reason === 'excess_payment' ? 'excess' : 'winning';
  if (attempt.status !== 'succeeded' || attempt.successKind !== requiredSuccessKind || !attempt.providerRef) {
    throw PlatformError.conflict(`Payment attempt ${attempt.reference} is not a refundable ${input.reason}`);
  }
  if (input.reason === 'reservation_cancellation' && reservation.status !== 'cancelled') {
    throw PlatformError.conflict(`Reservation ${reservation.id} must be cancelled before creating its cancellation refund`);
  }
  const amountMinor = input.reason === 'reservation_cancellation' ? input.amountMinor : attempt.amountMinor;
  const existing = await repository.findRefundByAttempt(context.tx, attempt.id);
  if (amountMinor === 0) {
    if (existing) throw PlatformError.conflict(`Payment attempt ${attempt.reference} already has immutable refund evidence`);
    return { refund: null, created: false };
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor === undefined || amountMinor <= 0 || amountMinor > attempt.amountMinor) {
    throw PlatformError.validation('Reservation refund amount must be a positive safe integer no greater than the received payment');
  }
  if (attempt.currency !== reservation.currency) throw PlatformError.conflict('Received payment currency does not match the Reservation');
  if (existing) {
    if (existing.reason !== input.reason || existing.amountMinor !== amountMinor || existing.currency !== attempt.currency
      || existing.provider !== attempt.provider || existing.paymentProviderRef !== attempt.providerRef) {
      throw PlatformError.conflict(`Payment attempt ${attempt.reference} already has different immutable refund evidence`);
    }
    if (input.allowExisting === false) {
      if (existing.status === 'failed') throw PlatformError.conflict(`Reservation refund ${existing.id} failed; use retryRefund`);
      if (existing.status === 'succeeded') throw PlatformError.conflict(`Reservation refund ${existing.id} is already completed`);
      throw PlatformError.conflict(`Reservation refund ${existing.id} is already pending`);
    }
    return { refund: toRefund(existing), created: false };
  }

  const id = randomUUID();
  const refund = await repository.insertRefund(context.tx, {
    id, reservationId: reservation.id, paymentAttemptId: attempt.id, reason: input.reason,
    provider: attempt.provider, paymentProviderRef: attempt.providerRef, amountMinor,
    currency: attempt.currency, providerRequestRef: `booking-refund:${id}`, status: 'pending', generation: 1,
    requestedAt: context.now, updatedAt: context.now,
  });
  await context.enqueue({
    type: PROCESS_BOOKING_RESERVATION_REFUND_JOB,
    payload: { refundId: refund.id, generation: refund.generation },
    dedupeKey: `booking-reservation:refund:${refund.id}:${refund.generation}`,
  });
  return { refund: toRefund(refund), created: true };
}

export const requestRequiredBookingReservationRefundCommand = defineCommand({
  name: 'booking.reservation.requestRequiredPaymentRefund', summary: 'Create the required refund for one classified received payment',
  input: requestRequiredBookingReservationRefundInputSchema, output: requestRequiredBookingReservationRefundOutputSchema,
  permission: 'booking-reservation:system-write', idempotency: 'required',
  audit: { action: 'booking.reservation.required-refund-requested', resourceType: 'booking_reservation_payment_attempt', resourceId: input => input.paymentAttemptId },
});
export function createRequestRequiredBookingReservationRefundHandler() {
  return async (input: RequestRequiredBookingReservationRefundInput, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system payment outcome may request a required Reservation refund');
    const result = await createRequiredBookingReservationRefund(context, { ...input, allowExisting: false });
    return { refund: result.refund! };
  };
}

export const getBookingReservationRefundForProcessingQuery = defineQuery({
  name: 'booking.reservation.getRefundForProcessing', summary: 'Load one current required Reservation refund for a worker',
  input: getBookingReservationRefundForProcessingInputSchema, output: getBookingReservationRefundForProcessingOutputSchema,
  permission: 'booking-reservation:system-write',
});
export async function getBookingReservationRefundForProcessingHandler(
  input: GetBookingReservationRefundForProcessingInput, context: QueryContext,
) {
  if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a refund worker may load a Reservation refund');
  const refund = await repository.findRefundById(context.db, input.refundId);
  if (!refund || refund.status !== 'pending' || refund.generation !== input.generation) return { kind: 'noop' as const };
  const workerAttempt = await repository.nextRefundWorkerAttempt(context.db, refund.id, refund.generation);
  return { kind: 'invoke' as const, provider: refund.provider, workerAttempt, request: {
    providerRef: refund.paymentProviderRef, amount: refund.amountMinor, currency: refund.currency, reference: refund.providerRequestRef,
  } };
}

export const recordBookingReservationRefundInvocationCommand = defineCommand({
  name: 'booking.reservation.recordRefundInvocation', summary: 'Persist one immutable Reservation refund provider invocation result',
  input: recordBookingReservationRefundInvocationInputSchema, output: recordBookingReservationRefundInvocationOutputSchema,
  permission: 'booking-reservation:system-write', idempotency: 'required',
  audit: { action: 'booking.reservation.refund-invocation-recorded', resourceType: 'booking_reservation_refund', resourceId: input => input.refundId,
    redact: input => ({ generation: input.generation, workerAttempt: input.workerAttempt, status: input.result.status }) },
});
export function createRecordBookingReservationRefundInvocationHandler() {
  return async (input: RecordBookingReservationRefundInvocationInput, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a refund worker may record Reservation provider evidence');
    const refund = await repository.lockRefundById(context.tx, input.refundId);
    if (!refund) throw PlatformError.notFound('Reservation refund', input.refundId);
    if (refund.generation !== input.generation || refund.status !== 'pending') return { refund: toRefund(refund) };
    await repository.insertRefundInvocation(context.tx, {
      id: randomUUID(), refundId: refund.id, generation: input.generation, workerAttempt: input.workerAttempt,
      outcome: input.result.status, providerRefundRef: input.result.status === 'succeeded' ? input.result.providerRefundRef : null,
      message: input.result.status === 'succeeded' ? null : input.result.message, invokedAt: context.now,
    });
    if (input.result.status === 'indeterminate' && !input.result.final) return { refund: toRefund(refund) };
    const updated = input.result.status === 'succeeded'
      ? await repository.updateRefund(context.tx, refund.id, { status: 'succeeded', providerRefundRef: input.result.providerRefundRef, failureKind: null, failureMessage: null, completedAt: context.now }, context.now)
      : await repository.updateRefund(context.tx, refund.id, { status: 'failed', failureKind: input.result.status, failureMessage: input.result.message, completedAt: context.now }, context.now);
    return { refund: toRefund(updated!) };
  };
}

export const retryBookingReservationRefundCommand = defineCommand({
  name: 'booking.reservation.retryRefund', summary: 'Retry a failed required Reservation refund with its stable provider reference',
  input: retryBookingReservationRefundInputSchema, output: retryBookingReservationRefundOutputSchema,
  permission: 'booking-reservation:refund-retry', idempotency: 'required',
  audit: { action: 'booking.reservation.refund-retried', resourceType: 'booking_reservation_refund', resourceId: input => input.refundId },
});
export function createRetryBookingReservationRefundHandler() {
  return async (input: RetryBookingReservationRefundInput, context: CommandContext) => {
    const refund = await repository.lockRefundById(context.tx, input.refundId);
    if (!refund) throw PlatformError.notFound('Reservation refund', input.refundId);
    if (refund.status !== 'failed') throw PlatformError.conflict(`Reservation refund ${refund.id} is not retryable (status=${refund.status})`);
    const updated = await repository.updateRefund(context.tx, refund.id, {
      status: 'pending', generation: refund.generation + 1, failureKind: null, failureMessage: null, completedAt: null,
    }, context.now);
    await context.enqueue({ type: PROCESS_BOOKING_RESERVATION_REFUND_JOB, payload: { refundId: refund.id, generation: updated!.generation },
      dedupeKey: `booking-reservation:refund:${refund.id}:${updated!.generation}` });
    return { refund: toRefund(updated!) };
  };
}

export const listBookingReservationRefundsQuery = defineQuery({
  name: 'booking.reservation.listRefunds', summary: 'List operator-visible Reservation refund headers',
  input: listBookingReservationRefundsInputSchema, output: listBookingReservationRefundsOutputSchema, permission: 'booking-reservation:refund-read',
});
export async function listBookingReservationRefundsHandler(input: ListBookingReservationRefundsInput, context: QueryContext) {
  requireBookingReservationOperator(context.actor);
  await requireBookingReservation(context.db, input.reservationId);
  const result = await repository.listRefunds(context.db, input);
  return {
    items: result.items.map(row => {
      const refund = toRefund(row);
      return {
        id: refund.id, reservationId: refund.reservationId, paymentAttemptId: refund.paymentAttemptId,
        reason: refund.reason, provider: refund.provider, paymentProviderRef: refund.paymentProviderRef,
        amountMinor: refund.amountMinor, currency: refund.currency, providerRequestRef: refund.providerRequestRef,
        status: refund.status, generation: refund.generation, providerRefundRef: refund.providerRefundRef,
        failureKind: refund.failureKind, requestedAt: refund.requestedAt,
        completedAt: refund.completedAt, updatedAt: refund.updatedAt,
      };
    }),
    total: result.total,
  };
}

export const reconcileBookingReservationRefundsCommand = defineCommand({
  name: 'booking.reservation.reconcileRefunds', summary: 'Reconcile pending Reservation refunds through the runtime job queue',
  input: z.object({}).strict(), output: z.object({ enqueued: z.number().int().nonnegative() }).strict(),
  permission: 'booking-reservation:system-write', idempotency: 'required',
  audit: { action: 'booking.reservation.refunds-reconciled', resourceType: 'booking_reservation_refund' },
});
export function createReconcileBookingReservationRefundsHandler() {
  return async (_input: Record<string, never>, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system worker may reconcile Reservation refunds');
    const pending = await repository.listPendingRefunds(context.tx);
    for (const refund of pending) await context.enqueue({ type: PROCESS_BOOKING_RESERVATION_REFUND_JOB,
      payload: { refundId: refund.id, generation: refund.generation }, dedupeKey: `booking-reservation:refund:${refund.id}:${refund.generation}`,
      // A worker can die after claiming an uncertain provider call but before
      // its evidence command commits. Replacing that dead occurrence uses the
      // platform queue's fenced, durable repair path; it never writes
      // platform_jobs directly and keeps the refund's stable provider reference.
      replaceExisting: true,
    });
    return { enqueued: pending.length };
  };
}
