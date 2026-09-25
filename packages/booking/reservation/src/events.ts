import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

/** Event payloads deliberately contain only stable Reservation consistency facts. */
export const bookingReservationConfirmedV1 = defineEvent({
  name: 'booking.reservation.confirmed.v1',
  summary: 'Reservation payment has selected its winning Attempt',
  payload: z.object({
    reservationId: z.string().uuid(),
    paymentAttemptId: z.string().uuid(),
    confirmedAt: z.coerce.date(),
  }).strict(),
});

export const bookingReservationCancelledV1 = defineEvent({
  name: 'booking.reservation.cancelled.v1',
  summary: 'Reservation has been cancelled',
  payload: z.object({
    reservationId: z.string().uuid(),
    cancelledAt: z.coerce.date(),
  }).strict(),
});

/** A deferred payment is actionable until this exact deadline. */
export const bookingReservationPaymentExpiringV1 = defineEvent({
  name: 'booking.reservation.paymentExpiring.v1',
  summary: 'Reservation has durable deferred-payment instructions with an expiry',
  payload: z.object({
    reservationId: z.string().uuid(),
    paymentAttemptId: z.string().uuid(),
    expiresAt: z.coerce.date(),
  }).strict(),
});

/** The Attempt ID is the stable logical alert identity across live delivery and reconciliation. */
export const bookingReservationLatePaymentV1 = defineEvent({
  name: 'booking.reservation.latePayment.v1',
  summary: 'A received payment was classified late and has a required full refund',
  payload: z.object({
    reservationId: z.string().uuid(),
    paymentAttemptId: z.string().uuid(),
    refundId: z.string().uuid(),
  }).strict(),
});

export const bookingReservationEvents = [
  bookingReservationConfirmedV1,
  bookingReservationCancelledV1,
  bookingReservationPaymentExpiringV1,
  bookingReservationLatePaymentV1,
] as const;
