import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { BookingAvailabilityRoomNightOperations } from '@storeweave/booking-availability';
import { BookingReservationRepository } from './repository';
import {
  expireBookingReservationInputSchema, expireBookingReservationOutputSchema,
  type ExpireBookingReservationInput,
} from './types';

const repository = new BookingReservationRepository();

export const expireBookingReservationCommand = defineCommand({
  name: 'booking.reservation.expire',
  summary: 'Expire an overdue pending-payment Reservation and release its Room Nights',
  input: expireBookingReservationInputSchema,
  output: expireBookingReservationOutputSchema,
  permission: 'booking-reservation:system-write',
  idempotency: 'required',
});

export function createExpireBookingReservationHandler(availability: BookingAvailabilityRoomNightOperations) {
  return async (input: ExpireBookingReservationInput, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system worker may expire a Reservation');

    const reservation = await repository.lockById(context.tx, input.reservationId);
    if (!reservation) return { kind: 'noop' as const };

    const expectedPaymentExpiresAt = new Date(input.expectedPaymentExpiresAt);
    if (reservation.status !== 'pending_payment'
      || reservation.paymentExpiresAt.getTime() !== expectedPaymentExpiresAt.getTime()) {
      return { kind: 'noop' as const };
    }

    // Queue claims use PostgreSQL's clock too. Keep expiry eligibility on that
    // same clock so a clock difference on the application host cannot consume
    // the one-shot job while leaving the Reservation held.
    const databaseNow = await repository.databaseNow(context.tx);
    if (reservation.paymentExpiresAt.getTime() > databaseNow.getTime()) return { kind: 'noop' as const };

    // Reservation locks before its active Attempts. This keeps an expiry from
    // racing a payment result into a released Room Night reservation.
    await repository.expireActivePaymentAttempts(context.tx, reservation.id, databaseNow);
    const updated = await repository.expireIfCurrent(context.tx, reservation, expectedPaymentExpiresAt);
    if (!updated) return { kind: 'noop' as const };

    await context.audit({
      action: 'booking.reservation.expired',
      resourceType: 'booking_reservation',
      resourceId: reservation.id,
      payload: { expectedPaymentExpiresAt: expectedPaymentExpiresAt.toISOString() },
    });

    // Release supply last. Any failure rolls back the state transition and audit too.
    await availability.release(context.tx, {
      roomTypeId: reservation.roomTypeId,
      startLocalDate: reservation.checkInLocalDate,
      endLocalDateExclusive: reservation.checkOutLocalDate,
      roomCount: reservation.roomCount,
    }, databaseNow);

    return { kind: 'expired' as const };
  };
}
