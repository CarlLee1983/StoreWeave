import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { BookingAvailabilityRoomNightOperations } from '@storeweave/booking-availability';
import type { BookingReservationAccess } from './access';
import { evaluateReservationCancellationEligibility } from './cancellation-policy';
import { accountIdFromActor } from './management';
import { BookingReservationRepository } from './repository';
import { createRequiredBookingReservationRefund } from './refunds';
import {
  cancelBookingReservationByOperatorInputSchema,
  cancelBookingReservationByOperatorOutputSchema,
  cancelBookingReservationSelfInputSchema,
  cancelBookingReservationSelfOutputSchema,
  type CancelBookingReservationByOperatorInput,
  type CancelBookingReservationSelfInput,
} from './types';

const repository = new BookingReservationRepository();

const cancellationOutput = (reservationId: string, refund: { id: string; amountMinor: number; currency: string } | null) => ({
  reservationId, cancelled: true as const, refund,
});

function noCancellationAccess(): PlatformError {
  return new PlatformError('UNAUTHENTICATED', 'Reservation cancellation access is invalid or has expired');
}

function cancellableStatus(status: string): boolean {
  return status === 'pending_payment' || status === 'confirmed';
}

export const cancelBookingReservationSelfCommand = defineCommand({
  name: 'booking.reservation.cancelSelf',
  summary: 'Cancel an authorized Reservation before its frozen cancellation deadline',
  input: cancelBookingReservationSelfInputSchema,
  output: cancelBookingReservationSelfOutputSchema,
  permission: 'booking-reservation:manage-self',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.self-cancelled', resourceType: 'booking_reservation', resourceId: input => input.reservationId,
    redact: input => ({ accessMethod: input.managementCredential === undefined ? 'account-owner' : 'management-credential' }),
  },
});

export const cancelBookingReservationByOperatorCommand = defineCommand({
  name: 'booking.reservation.cancelByOperator',
  summary: 'Cancel a Reservation under operator authority with an auditable refund decision',
  input: cancelBookingReservationByOperatorInputSchema,
  output: cancelBookingReservationByOperatorOutputSchema,
  permission: 'booking-reservation:cancel',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.operator-cancelled', resourceType: 'booking_reservation', resourceId: input => input.reservationId,
    redact: input => ({ refundAmountMinor: input.refundAmountMinor, reason: input.reason }),
  },
});

async function cancelLockedReservation(
  reservationId: string,
  refundAmountMinor: number,
  context: CommandContext,
  availability: BookingAvailabilityRoomNightOperations,
  audit: { action: string; payload: Record<string, unknown> },
) {
  const reservation = await repository.lockById(context.tx, reservationId);
  if (!reservation) throw PlatformError.notFound('Reservation', reservationId);
  if (!cancellableStatus(reservation.status)) throw PlatformError.conflict(`Reservation ${reservation.id} cannot be cancelled while ${reservation.status}`);
  const attempts = await repository.lockPaymentAttemptsForReservation(context.tx, reservation.id);
  const winner = reservation.winningPaymentAttemptId === null ? undefined
    : attempts.find(attempt => attempt.id === reservation.winningPaymentAttemptId);
  if (winner && (winner.status !== 'succeeded' || winner.successKind !== 'winning' || !winner.providerRef)) {
    throw PlatformError.conflict(`Reservation ${reservation.id} has invalid winning payment evidence`);
  }
  if (refundAmountMinor > (winner?.amountMinor ?? 0)) {
    throw PlatformError.validation('Reservation refund amount cannot exceed the received winning payment');
  }
  const databaseNow = await repository.databaseNow(context.tx);
  await repository.expireActivePaymentAttempts(context.tx, reservation.id, databaseNow);
  if (!await repository.cancelIfCurrent(context.tx, reservation.id)) {
    throw PlatformError.conflict(`Reservation ${reservation.id} changed while cancellation was in progress`);
  }
  const refund = refundAmountMinor === 0 ? null : await createRequiredBookingReservationRefund(context, {
    reservationId: reservation.id,
    paymentAttemptId: winner!.id,
    reason: 'reservation_cancellation',
    amountMinor: refundAmountMinor,
    allowExisting: false,
  }).then(result => result.refund);

  await context.audit({
    action: audit.action,
    resourceType: 'booking_reservation',
    resourceId: reservation.id,
    payload: audit.payload,
  });

  // Supply release is last: a failure rolls back the state, refund work, and audit.
  await availability.release(context.tx, {
    roomTypeId: reservation.roomTypeId,
    startLocalDate: reservation.checkInLocalDate,
    endLocalDateExclusive: reservation.checkOutLocalDate,
    roomCount: reservation.roomCount,
  }, databaseNow);
  return cancellationOutput(reservation.id, refund === null ? null : {
    id: refund.id, amountMinor: refund.amountMinor, currency: refund.currency,
  });
}

export function createCancelBookingReservationSelfHandler(
  access: BookingReservationAccess,
  availability: BookingAvailabilityRoomNightOperations,
) {
  return async (input: CancelBookingReservationSelfInput, context: CommandContext) => {
    const reservation = await repository.lockById(context.tx, input.reservationId);
    if (!reservation) throw PlatformError.notFound('Reservation', input.reservationId);
    if (input.managementCredential !== undefined) {
      const authorized = await access.authorizeManagement(context.tx, {
        reservationId: input.reservationId,
        managementCredential: input.managementCredential,
      });
      if (authorized.reservationId !== reservation.id) throw noCancellationAccess();
    } else {
      const accountId = accountIdFromActor(context.actor);
      if (reservation.ownerAccountId !== accountId) throw PlatformError.notFound('Reservation', reservation.id);
    }
    // This is deliberately wall-clock time: the transaction may have spent time waiting on the Reservation lock.
    const databaseNow = await repository.databaseWallClock(context.tx);
    const eligibility = evaluateReservationCancellationEligibility({
      checkInLocalDate: reservation.checkInLocalDate, cancellationPolicy: reservation.cancellationPolicy, now: databaseNow,
    });
    if (eligibility.kind === 'invalid') throw PlatformError.conflict('Reservation cancellation policy is invalid');
    if (eligibility.kind === 'ineligible') throw PlatformError.conflict('Reservation cancellation deadline has passed');
    const attempts = await repository.lockPaymentAttemptsForReservation(context.tx, reservation.id);
    const winner = reservation.winningPaymentAttemptId === null ? undefined
      : attempts.find(attempt => attempt.id === reservation.winningPaymentAttemptId);
    return cancelLockedReservation(reservation.id, winner?.amountMinor ?? 0, context, availability, {
      action: 'booking.reservation.self-cancelled',
      payload: { accessMethod: input.managementCredential === undefined ? 'account-owner' : 'management-credential' },
    });
  };
}

export function createCancelBookingReservationByOperatorHandler(availability: BookingAvailabilityRoomNightOperations) {
  return async (input: CancelBookingReservationByOperatorInput, context: CommandContext) => {
    if (context.actor.type !== 'user') throw PlatformError.forbidden('Only an operator may cancel a Reservation');
    return cancelLockedReservation(input.reservationId, input.refundAmountMinor, context, availability, {
      action: 'booking.reservation.operator-cancelled',
      payload: { refundAmountMinor: input.refundAmountMinor, reason: input.reason },
    });
  };
}
