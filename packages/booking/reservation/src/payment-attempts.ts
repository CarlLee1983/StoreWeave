import { randomUUID } from 'node:crypto';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { PaymentInitiationInput, PaymentInitiationResult, PaymentMethod } from '@storeweave/extension-sdk';
import { BookingReservationRepository } from './repository';
import { PROCESS_BOOKING_RESERVATION_PAYMENT_JOB } from './jobs';
import {
  recordBookingReservationPaymentResultInputSchema,
  recordBookingReservationPaymentResultOutputSchema,
  BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES,
  bookingReservationPaymentAttemptStatusSchema,
  getBookingReservationPaymentAttemptForProcessingInputSchema,
  getBookingReservationPaymentAttemptForProcessingOutputSchema,
  startBookingReservationPaymentInputSchema,
  startBookingReservationPaymentOutputSchema,
  type BookingReservationPaymentAttempt,
  type GetBookingReservationPaymentAttemptForProcessingInput,
  type RecordBookingReservationPaymentResultInput,
  type StartBookingReservationPaymentInput,
} from './types';

const repository = new BookingReservationRepository();
/** Reservation owns this narrow neutral Provider port; it never sees Commerce payment types. */
export interface BookingReservationPaymentProvider {
  readonly id: string;
  paymentMethods(): readonly PaymentMethod[];
  initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult>;
}

function toAttemptOutput(row: {
  id: string;
  reservationId: string;
  reference: string;
  provider: string;
  method: string;
  amountMinor: number;
  currency: string;
  status: string;
  providerRef: string | null;
  expiresAt: Date;
}): BookingReservationPaymentAttempt {
  return {
    id: row.id,
    reservationId: row.reservationId,
    reference: row.reference,
    provider: row.provider,
    method: row.method,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: bookingReservationPaymentAttemptStatusSchema.parse(row.status),
    providerRef: row.providerRef,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function isActivePaymentAttemptStatus(status: string): boolean {
  return BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES.some(candidate => candidate === status);
}

function resolveDeferredMethod(provider: BookingReservationPaymentProvider, requested: string): PaymentMethod {
  const method = provider.paymentMethods().find(candidate => candidate.code === requested);
  if (!method) throw PlatformError.validation(`Payment method ${requested} is not enabled for provider ${provider.id}`);
  // Immediate confirmation must be resolved by SW-128's winning-payment path;
  // accepting it here could charge before Reservation state can be confirmed.
  if (method.timing !== 'deferred') {
    throw PlatformError.validation(`Payment method ${requested} is not supported until Booking callback handling is available`);
  }
  return method;
}

export const startBookingReservationPaymentCommand = defineCommand({
  name: 'booking.reservation.startPayment',
  summary: 'Create one idempotent Reservation payment attempt',
  input: startBookingReservationPaymentInputSchema,
  output: startBookingReservationPaymentOutputSchema,
  permission: 'booking-reservation:pay',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.payment-started',
    resourceType: 'booking_reservation',
    resourceId: input => input.reservationId,
    redact: input => ({ method: input.method }),
  },
});

export const recordBookingReservationPaymentResultCommand = defineCommand({
  name: 'booking.reservation.recordPaymentResult',
  summary: 'Record a Reservation payment provider initiation result',
  input: recordBookingReservationPaymentResultInputSchema,
  output: recordBookingReservationPaymentResultOutputSchema,
  permission: 'booking-reservation:system-write',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.payment-result-recorded',
    resourceType: 'booking_reservation_payment_attempt',
    resourceId: input => input.attemptId,
    redact: input => ({ provider: input.provider, status: input.result.status }),
  },
});

export const getBookingReservationPaymentAttemptForProcessingQuery = defineQuery({
  name: 'booking.reservation.getPaymentAttemptForProcessing',
  summary: 'Load a current Reservation payment Attempt for a payment worker',
  input: getBookingReservationPaymentAttemptForProcessingInputSchema,
  output: getBookingReservationPaymentAttemptForProcessingOutputSchema,
  permission: 'booking-reservation:system-write',
});

export async function getBookingReservationPaymentAttemptForProcessingHandler(
  input: GetBookingReservationPaymentAttemptForProcessingInput,
  context: QueryContext,
) {
  if (context.actor.type !== 'system') {
    throw PlatformError.forbidden('Only a payment worker may load a Reservation payment attempt');
  }
  const attempt = await repository.findPaymentAttemptById(context.db, input.attemptId);
  if (!attempt || attempt.provider !== input.provider || attempt.reference !== input.reference || attempt.status !== 'created') {
    return { kind: 'noop' as const };
  }
  const reservation = await repository.findById(context.db, attempt.reservationId);
  const databaseNow = await repository.databaseNow(context.db);
  if (!reservation || reservation.status !== 'pending_payment'
    || reservation.paymentExpiresAt.getTime() <= databaseNow.getTime()
    || attempt.expiresAt.getTime() <= databaseNow.getTime()) {
    return { kind: 'noop' as const };
  }
  return {
    kind: 'invoke' as const,
    request: {
      reference: attempt.reference,
      displayReference: reservation.id,
      amount: attempt.amountMinor,
      currency: attempt.currency,
      method: attempt.method,
    },
  };
}

export function createStartBookingReservationPaymentHandler(provider: BookingReservationPaymentProvider) {
  return async (input: StartBookingReservationPaymentInput, context: CommandContext) => {
    resolveDeferredMethod(provider, input.method);
    const reservation = await repository.lockById(context.tx, input.reservationId);
    if (!reservation) throw PlatformError.notFound('Reservation', input.reservationId);
    if (reservation.status !== 'pending_payment') {
      throw PlatformError.conflict(`Reservation ${reservation.id} cannot start payment while ${reservation.status}`);
    }
    const databaseNow = await repository.databaseNow(context.tx);
    if (reservation.paymentExpiresAt.getTime() <= databaseNow.getTime()) {
      throw PlatformError.conflict(`Reservation ${reservation.id} payment window has expired`);
    }
    if (reservation.totalMinor <= 0) {
      throw PlatformError.validation(`Reservation ${reservation.id} does not require a payment attempt`);
    }
    const active = await repository.findActivePaymentAttempt(context.tx, reservation.id);
    if (active) {
      if (active.expiresAt.getTime() > databaseNow.getTime()) {
        throw PlatformError.conflict(`Reservation ${reservation.id} already has active payment attempt ${active.reference}`);
      }
      await repository.updatePaymentAttempt(context.tx, active.id, { status: 'expired' }, databaseNow);
    }

    const attempt = await repository.insertPaymentAttempt(context.tx, {
      id: randomUUID(),
      reservationId: reservation.id,
      reference: `booking-payment:${randomUUID()}`,
      provider: provider.id,
      method: input.method,
      amountMinor: reservation.totalMinor,
      currency: reservation.currency,
      status: 'created',
      expiresAt: reservation.paymentExpiresAt,
      createdAt: context.now,
      updatedAt: context.now,
    });
    await context.enqueue({
      type: PROCESS_BOOKING_RESERVATION_PAYMENT_JOB,
      payload: {
        attemptId: attempt.id,
        reservationId: reservation.id,
        provider: attempt.provider,
        reference: attempt.reference,
      },
      dedupeKey: `booking-reservation:payment:${attempt.reference}`,
    });
    return { attempt: toAttemptOutput(attempt) };
  };
}

export function createRecordBookingReservationPaymentResultHandler() {
  return async (input: RecordBookingReservationPaymentResultInput, context: CommandContext) => {
    if (context.actor.type !== 'system') {
      throw PlatformError.forbidden('Only a payment worker may record Reservation payment results');
    }
    const found = await repository.findPaymentAttemptById(context.tx, input.attemptId);
    if (!found) throw PlatformError.notFound('Reservation payment attempt', input.attemptId);
    // Reservation always locks before its payment attempts; expiry, callback,
    // cancellation, and payment work therefore serialize on the aggregate.
    const reservation = await repository.lockById(context.tx, found.reservationId);
    if (!reservation) throw PlatformError.notFound('Reservation', found.reservationId);
    const attempt = await repository.lockPaymentAttemptById(context.tx, input.attemptId);
    if (!attempt) throw PlatformError.notFound('Reservation payment attempt', input.attemptId);
    if (attempt.provider !== input.provider) {
      throw PlatformError.validation('Payment provider does not match the Reservation payment attempt');
    }
    if (reservation.status !== 'pending_payment' || !isActivePaymentAttemptStatus(attempt.status)) {
      if (input.result.status !== 'confirmed') return { attempt: toAttemptOutput(attempt) };
      // A confirmation can arrive after expiry has released the Room Nights.
      // Preserve its provider evidence for SW-128's Late Payment refund path;
      // it must never resurrect this Reservation in SW-127.
      const updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
        providerRef: input.result.providerRef,
        failureMessage: 'Synchronous confirmation awaits Booking winner selection',
      }, context.now))!;
      return { attempt: toAttemptOutput(updated) };
    }

    let updated = attempt;
    switch (input.result.status) {
      case 'redirect':
        updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
          status: 'submitted', providerRef: input.result.providerRef, action: input.result.action,
          instructions: null, failureReason: null, failureMessage: null,
        }, context.now))!;
        break;
      case 'awaiting_payment': {
        // This Story may shorten an Attempt to the provider's definite
        // instruction deadline, but never extends the Reservation window.
        const providerExpiresAt = new Date(input.result.expiresAt);
        const expiresAt = providerExpiresAt.getTime() < attempt.expiresAt.getTime()
          ? providerExpiresAt
          : attempt.expiresAt;
        updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
          status: 'awaiting_payment', providerRef: input.result.providerRef,
          instructions: [...input.result.instructions], expiresAt, failureReason: null, failureMessage: null,
        }, context.now))!;
        break;
      }
      case 'failed':
        updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
          status: 'failed', providerRef: input.result.providerRef ?? attempt.providerRef,
          failureReason: input.result.reason, failureMessage: input.result.message,
        }, context.now))!;
        break;
      case 'confirmed':
        // Winning-payment selection belongs to SW-128. Retain the provider
        // evidence but keep the attempt active so a new payment cannot start.
        updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
          providerRef: input.result.providerRef,
          failureMessage: 'Synchronous confirmation awaits Booking winner selection',
        }, context.now))!;
        break;
    }
    return { attempt: toAttemptOutput(updated) };
  };
}
