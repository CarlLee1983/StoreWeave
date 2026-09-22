import { randomUUID } from 'node:crypto';
import { defineCommand, type CommandContext } from '@storeweave/contracts';
import type { BookingAvailabilityQuoteReservation } from '@storeweave/booking-availability';
import { BookingReservationRepository } from './repository';
import type { BookingReservationCheckoutAccess } from './checkout-access';
import { EXPIRE_BOOKING_RESERVATION_JOB } from './jobs';
import {
  createBookingReservationInputSchema, createBookingReservationOutputSchema,
  type CreateBookingReservationInput,
} from './types';

const DEFAULT_PAYMENT_WINDOW_MS = 15 * 60 * 1000;
const repository = new BookingReservationRepository();

export const createBookingReservationCommand = defineCommand({
  name: 'booking.reservation.create',
  summary: '建立 Booking Reservation',
  input: createBookingReservationInputSchema,
  output: createBookingReservationOutputSchema,
  permission: 'booking-reservation:create',
  idempotency: 'required',
  audit: {
    action: 'booking.reservation.create-requested',
    resourceType: 'booking_reservation',
    resourceId: (_input, output) => output.kind === 'created' ? output.reservation.id : undefined,
    redact: input => ({
      roomTypeId: input.quote.roomTypeId,
      checkInLocalDate: input.quote.checkInLocalDate,
      checkOutLocalDate: input.quote.checkOutLocalDate,
      roomCount: input.quote.roomCount,
      adults: input.quote.adults,
      children: input.quote.children,
    }),
  },
});

export function createBookingReservationHandler(availability: BookingAvailabilityQuoteReservation, checkout: BookingReservationCheckoutAccess) {
  return async (input: CreateBookingReservationInput, context: CommandContext) => {
    const { fingerprint, ...quoteRequest } = input.quote;
    const result = await availability.revalidateAndReserve(context.tx, quoteRequest, fingerprint, context.now);
    if (result.kind === 'stale') return { kind: 'stale' as const, replacementQuote: result.replacementQuote };
    if (result.kind === 'unavailable') return { kind: 'unavailable' as const };

    const id = randomUUID();
    const paymentExpiresAt = new Date(context.now.getTime() + DEFAULT_PAYMENT_WINDOW_MS);
    const checkoutCredential = checkout.prepare(id, paymentExpiresAt);
    await repository.insert(context.tx, {
      id,
      roomTypeId: result.quote.roomTypeId,
      checkInLocalDate: result.quote.checkInLocalDate,
      checkOutLocalDate: result.quote.checkOutLocalDate,
      roomCount: result.quote.roomCount,
      adults: result.quote.adults,
      children: result.quote.children,
      bookerName: input.booker.name,
      bookerEmail: input.booker.email,
      bookerPhone: input.booker.phone,
      primaryGuestName: input.primaryGuestName,
      accommodationNotes: input.accommodationNotes ?? null,
      status: 'pending_payment',
      paymentExpiresAt,
      currency: result.quote.currency,
      totalMinor: result.quote.totalMinor,
      nightlyPrices: result.quote.nights,
      cancellationPolicy: result.quote.cancellationPolicy,
      quoteFingerprint: result.quote.fingerprint,
      createdAt: context.now,
      checkoutCredentialKeyId: checkoutCredential.keyId,
      checkoutCredentialNonce: checkoutCredential.nonce,
      checkoutCredentialHash: checkoutCredential.tokenHash,
      checkoutCredentialExpiresAt: checkoutCredential.expiresAt,
    });

    await context.enqueue({
      type: EXPIRE_BOOKING_RESERVATION_JOB,
      payload: { reservationId: id, expectedPaymentExpiresAt: paymentExpiresAt.toISOString() },
      dedupeKey: `booking-reservation:expire:${id}`,
      runAt: paymentExpiresAt,
    });

    return {
      kind: 'created' as const,
      reservation: {
        id,
        status: 'pending_payment' as const,
        paymentExpiresAt: paymentExpiresAt.toISOString(),
        quote: result.quote,
      },
    };
  };
}
