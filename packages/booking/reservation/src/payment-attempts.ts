import { randomUUID } from 'node:crypto';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { PaymentInitiationInput, PaymentInitiationResult, PaymentMethod, PaymentCallbackEvent, PaymentRefundInputV2, PaymentRefundResult } from '@storeweave/extension-sdk';
import { BookingReservationRepository } from './repository';
import { EXPIRE_BOOKING_RESERVATION_JOB, PROCESS_BOOKING_RESERVATION_PAYMENT_JOB } from './jobs';
import { createRequiredBookingReservationRefund } from './refunds';
import {
  recordBookingReservationPaymentResultInputSchema,
  recordBookingReservationPaymentResultOutputSchema,
  recordVerifiedBookingPaymentOutcomeInputSchema,
  recordVerifiedBookingPaymentOutcomeOutputSchema,
  BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES,
  bookingReservationPaymentAttemptStatusSchema,
  getBookingReservationPaymentAttemptForProcessingInputSchema,
  getBookingReservationPaymentAttemptForProcessingOutputSchema,
  startBookingReservationPaymentInputSchema,
  startBookingReservationPaymentOutputSchema,
  type BookingReservationPaymentAttempt,
  type GetBookingReservationPaymentAttemptForProcessingInput,
  type RecordBookingReservationPaymentResultInput,
  type RecordVerifiedBookingPaymentOutcomeInput,
  type StartBookingReservationPaymentInput,
} from './types';

const repository = new BookingReservationRepository();
/** Reservation owns this narrow neutral Provider port; it never sees Commerce payment types. */
export interface BookingReservationPaymentProvider {
  readonly id: string;
  paymentMethods(): readonly PaymentMethod[];
  initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult>;
  refund(input: PaymentRefundInputV2): Promise<PaymentRefundResult>;
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

function resolvePaymentMethod(provider: BookingReservationPaymentProvider, requested: string): PaymentMethod {
  const method = provider.paymentMethods().find(candidate => candidate.code === requested);
  if (!method) throw PlatformError.validation(`Payment method ${requested} is not enabled for provider ${provider.id}`);
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

export const recordVerifiedBookingPaymentOutcomeCommand = defineCommand({
  name: 'booking.reservation.recordVerifiedPaymentOutcome',
  summary: 'Apply a verified neutral payment callback outcome to a Reservation Attempt',
  input: recordVerifiedBookingPaymentOutcomeInputSchema,
  output: recordVerifiedBookingPaymentOutcomeOutputSchema,
  permission: 'booking-reservation:system-write',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.verified-payment-outcome-recorded',
    resourceType: 'booking_reservation_payment_attempt',
    resourceId: () => undefined,
    redact: input => ({ provider: input.provider, type: input.event.type, reference: input.event.reference }),
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
    resolvePaymentMethod(provider, input.method);
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
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a payment worker may record Reservation payment results');
    if (input.result.status === 'redirect') {
      const found = await repository.findPaymentAttemptById(context.tx, input.attemptId);
      if (!found) throw PlatformError.notFound('Reservation payment attempt', input.attemptId);
      const reservation = await repository.lockById(context.tx, found.reservationId);
      if (!reservation) throw PlatformError.notFound('Reservation', found.reservationId);
      const [attempt] = await repository.lockPaymentAttemptsForReservation(context.tx, reservation.id)
        .then(rows => rows.filter(row => row.id === input.attemptId));
      if (!attempt) throw PlatformError.notFound('Reservation payment attempt', input.attemptId);
      if (attempt.provider !== input.provider) throw PlatformError.validation('Payment provider does not match the Reservation payment attempt');
      if (reservation.status !== 'pending_payment' || !isActivePaymentAttemptStatus(attempt.status)) return { attempt: toAttemptOutput(attempt) };
      const updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
        status: 'submitted', providerRef: input.result.providerRef, action: input.result.action,
        instructions: null, failureReason: null, failureMessage: null,
      }, context.now))!;
      return { attempt: toAttemptOutput(updated) };
    }
    return applyPaymentOutcome(input.attemptId, input.provider, initiationResultToEvent(input.result), 'initiation', context);
  };
}

function initiationResultToEvent(result: Exclude<PaymentInitiationResult, { status: 'redirect' }>): PaymentCallbackEvent {
  switch (result.status) {
    case 'confirmed': return { type: 'payment_confirmed', reference: '', providerRef: result.providerRef };
    case 'awaiting_payment': return { type: 'payment_info_issued', reference: '', providerRef: result.providerRef, instructions: result.instructions, expiresAt: result.expiresAt };
    case 'failed': return { type: 'payment_failed', reference: '', providerRef: result.providerRef, message: result.message };
  }
}

type PaymentOutcomeOrigin = 'initiation' | 'verified-callback';

async function applyPaymentOutcome(
  attemptId: string,
  provider: string,
  event: PaymentCallbackEvent,
  origin: PaymentOutcomeOrigin,
  context: CommandContext,
) {
  const found = await repository.findPaymentAttemptById(context.tx, attemptId);
  if (!found) throw PlatformError.notFound('Reservation payment attempt', attemptId);
  const reservation = await repository.lockById(context.tx, found.reservationId);
  if (!reservation) throw PlatformError.notFound('Reservation', found.reservationId);
  const attempts = await repository.lockPaymentAttemptsForReservation(context.tx, reservation.id);
  const attempt = attempts.find(candidate => candidate.id === attemptId);
  if (!attempt) throw PlatformError.notFound('Reservation payment attempt', attemptId);
  if (attempt.provider !== provider) throw PlatformError.validation('Payment provider does not match the Reservation payment attempt');
  const databaseNow = await repository.databaseNow(context.tx);
  switch (event.type) {
    case 'payment_confirmed': {
      if (attempt.status === 'succeeded') {
        if (attempt.providerRef !== event.providerRef) throw PlatformError.conflict(`Payment attempt ${attempt.reference} was confirmed with a different provider reference`);
        if (attempt.successKind === 'late' || attempt.successKind === 'excess') {
          await createRequiredBookingReservationRefund(context, {
            reservationId: reservation.id, paymentAttemptId: attempt.id,
            reason: attempt.successKind === 'late' ? 'late_payment' : 'excess_payment', allowExisting: true,
          });
        }
        return { attempt: toAttemptOutput(attempt) };
      }
      const winner = attempts.find(candidate => candidate.successKind === 'winning');
      const kind = reservation.status === 'pending_payment' && !winner ? 'winning'
        : winner ? 'excess' : 'late';
      const updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
        status: 'succeeded', providerRef: event.providerRef, successKind: kind, succeededAt: databaseNow,
        failureReason: null, failureMessage: null,
      }, context.now))!;
      if (kind === 'winning') {
        await repository.confirmWithWinningAttempt(context.tx, reservation.id, attempt.id);
        await repository.expireActivePaymentAttempts(context.tx, reservation.id, databaseNow);
      } else {
        await createRequiredBookingReservationRefund(context, {
          reservationId: reservation.id, paymentAttemptId: attempt.id,
          reason: kind === 'late' ? 'late_payment' : 'excess_payment', allowExisting: true,
        });
      }
      return { attempt: toAttemptOutput(updated) };
    }
    case 'payment_info_issued': {
      if (reservation.status !== 'pending_payment' || !isActivePaymentAttemptStatus(attempt.status)) return { attempt: toAttemptOutput(attempt) };
      const expiresAt = new Date(event.expiresAt);
      if (expiresAt.getTime() <= databaseNow.getTime()) throw PlatformError.validation('Payment instructions have already expired');
      const firstInstructions = attempt.status !== 'awaiting_payment';
      // An initiation result can only shorten the window it just opened. A
      // verified callback is authoritative: its first outcome applies its
      // exact provider deadline, while later older outcomes are stale.
      const effectiveExpiresAt = origin === 'initiation'
        ? new Date(Math.min(expiresAt.getTime(), reservation.paymentExpiresAt.getTime()))
        : expiresAt;
      const exactReplay = !firstInstructions
        && attempt.providerRef === event.providerRef
        && attempt.expiresAt.getTime() === effectiveExpiresAt.getTime()
        && JSON.stringify(attempt.instructions) === JSON.stringify(event.instructions);
      if (exactReplay) return { attempt: toAttemptOutput(attempt) };
      if (!firstInstructions && effectiveExpiresAt.getTime() <= attempt.expiresAt.getTime()) {
        return { attempt: toAttemptOutput(attempt) };
      }
      const updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
        status: 'awaiting_payment', providerRef: event.providerRef, instructions: [...event.instructions],
        expiresAt: effectiveExpiresAt, failureReason: null, failureMessage: null,
      }, context.now))!;
      const reservationExpiresAt = effectiveExpiresAt.getTime() > reservation.paymentExpiresAt.getTime()
        ? effectiveExpiresAt : reservation.paymentExpiresAt;
      if (reservationExpiresAt.getTime() !== reservation.paymentExpiresAt.getTime()) {
        await repository.extendPaymentDeadline(context.tx, reservation.id, reservationExpiresAt);
      }
      await context.enqueue({
        type: EXPIRE_BOOKING_RESERVATION_JOB,
        payload: { reservationId: reservation.id, expectedPaymentExpiresAt: reservationExpiresAt.toISOString() },
        dedupeKey: `booking-reservation:expire:${reservation.id}`, runAt: reservationExpiresAt, replaceExisting: true,
      });
      return { attempt: toAttemptOutput(updated) };
    }
    case 'payment_failed': {
      if (reservation.status !== 'pending_payment' || !isActivePaymentAttemptStatus(attempt.status)) return { attempt: toAttemptOutput(attempt) };
      const updated = (await repository.updatePaymentAttempt(context.tx, attempt.id, {
        status: 'failed', providerRef: event.providerRef ?? attempt.providerRef,
        failureReason: 'provider_rejected', failureMessage: event.message ?? 'Payment provider rejected this attempt',
      }, context.now))!;
      return { attempt: toAttemptOutput(updated) };
    }
  }
}

export function createRecordVerifiedBookingPaymentOutcomeHandler() {
  return async (input: RecordVerifiedBookingPaymentOutcomeInput, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a verified callback bridge may record Reservation payment outcomes');
    const found = await repository.findPaymentAttemptByReference(context.tx, input.event.reference);
    if (!found) throw PlatformError.notFound('Reservation payment attempt reference', input.event.reference);
    return applyPaymentOutcome(found.id, input.provider, input.event, 'verified-callback', context);
  };
}
