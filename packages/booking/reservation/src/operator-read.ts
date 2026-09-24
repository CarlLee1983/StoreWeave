import { z } from 'zod';
import { isCanonicalLocalDate, bookingQuoteSchema } from '@storeweave/booking-availability';
import { PlatformError, defineQuery, type Actor, type QueryContext } from '@storeweave/contracts';
import { BookingReservationRepository } from './repository';
import type { BookingReservationPaymentAttemptRow, BookingReservationRow } from './schema';
import { bookingReservationPaymentAttemptStatusSchema } from './types';

const repository = new BookingReservationRepository();
const reservationStatus = z.enum(['pending_payment', 'confirmed', 'expired', 'cancelled']);
const localDate = z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form');
const page = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10_000).default(0),
};

export function requireBookingReservationOperator(actor: Actor): void {
  if (actor.type !== 'user') throw PlatformError.forbidden('Only an operator may read Reservation evidence');
}

export async function requireBookingReservation(db: QueryContext['db'], reservationId: string): Promise<BookingReservationRow> {
  const reservation = await repository.findById(db, reservationId);
  if (!reservation) throw PlatformError.notFound('Reservation');
  return reservation;
}

export const listOperatorBookingReservationsInputSchema = z.object({
  ...page,
  status: reservationStatus.optional(),
  roomTypeId: z.string().uuid().optional(),
  checkInFrom: localDate.optional(),
  checkInTo: localDate.optional(),
}).strict().superRefine((input, context) => {
  if (input.checkInFrom === undefined || input.checkInTo === undefined) return;
  const days = (Date.parse(`${input.checkInTo}T00:00:00Z`) - Date.parse(`${input.checkInFrom}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days > 366) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checkInTo'], message: 'Check-in range must be ordered and at most 366 days' });
  }
});

const operatorReservationListItemSchema = z.object({
  id: z.string().uuid(), status: reservationStatus, roomTypeId: z.string().uuid(),
  checkInLocalDate: localDate, checkOutLocalDate: localDate,
  roomCount: z.number().int().positive(), adults: z.number().int().nonnegative(), children: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/), totalMinor: z.number().int().safe().nonnegative(),
  paymentExpiresAt: z.string().datetime(), createdAt: z.string().datetime(),
}).strict();

export const listOperatorBookingReservationsOutputSchema = z.object({
  items: z.array(operatorReservationListItemSchema), total: z.number().int().nonnegative(),
}).strict();

export const listOperatorBookingReservationsQuery = defineQuery({
  name: 'booking.reservation.listOperator',
  summary: 'List bounded, PII-minimized Reservation rows for a human operator',
  input: listOperatorBookingReservationsInputSchema,
  output: listOperatorBookingReservationsOutputSchema,
  permission: 'booking-reservation:operator-read',
});

export async function listOperatorBookingReservationsHandler(
  input: z.output<typeof listOperatorBookingReservationsInputSchema>, context: QueryContext,
) {
  requireBookingReservationOperator(context.actor);
  const result = await repository.listOperatorReservations(context.db, input);
  return {
    items: result.items.map(row => ({
      id: row.id, status: row.status, roomTypeId: row.roomTypeId,
      checkInLocalDate: row.checkInLocalDate, checkOutLocalDate: row.checkOutLocalDate,
      roomCount: row.roomCount, adults: row.adults, children: row.children,
      currency: row.currency, totalMinor: row.totalMinor,
      paymentExpiresAt: row.paymentExpiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
    })),
    total: result.total,
  };
}

export const getOperatorBookingReservationInputSchema = z.object({ reservationId: z.string().uuid() }).strict();
const operatorReservationDetailSchema = operatorReservationListItemSchema.extend({
  booker: z.object({
    name: z.string().min(1).max(160).nullable(),
    email: z.string().email().max(320).nullable(),
    phone: z.string().min(1).max(40).nullable(),
  }).strict(),
  primaryGuestName: z.string().min(1).max(160).nullable(),
  accommodationNotes: z.string().max(2000).nullable(),
  winningPaymentAttemptId: z.string().uuid().nullable(),
  nights: bookingQuoteSchema.shape.nights,
  cancellationPolicy: bookingQuoteSchema.shape.cancellationPolicy,
}).strict();
export const getOperatorBookingReservationOutputSchema = z.object({ reservation: operatorReservationDetailSchema }).strict();

export const getOperatorBookingReservationQuery = defineQuery({
  name: 'booking.reservation.getOperator',
  summary: 'Read a deliberate Reservation detail snapshot for a human operator',
  input: getOperatorBookingReservationInputSchema,
  output: getOperatorBookingReservationOutputSchema,
  permission: 'booking-reservation:operator-read',
});

export async function getOperatorBookingReservationHandler(
  input: z.output<typeof getOperatorBookingReservationInputSchema>, context: QueryContext,
) {
  requireBookingReservationOperator(context.actor);
  const row = await requireBookingReservation(context.db, input.reservationId);
  const anonymized = row.piiAnonymizedAt !== null;
  return { reservation: {
    id: row.id, status: row.status, roomTypeId: row.roomTypeId,
    checkInLocalDate: row.checkInLocalDate, checkOutLocalDate: row.checkOutLocalDate,
    roomCount: row.roomCount, adults: row.adults, children: row.children,
    currency: row.currency, totalMinor: row.totalMinor,
    paymentExpiresAt: row.paymentExpiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
    booker: {
      name: anonymized ? null : row.bookerName,
      email: anonymized ? null : row.bookerEmail,
      phone: anonymized ? null : row.bookerPhone,
    },
    primaryGuestName: anonymized ? null : row.primaryGuestName,
    accommodationNotes: anonymized ? null : row.accommodationNotes,
    winningPaymentAttemptId: row.winningPaymentAttemptId,
    nights: row.nightlyPrices,
    cancellationPolicy: row.cancellationPolicy,
  } };
}

export const listOperatorBookingPaymentAttemptsInputSchema = z.object({
  reservationId: z.string().uuid(), ...page,
}).strict();
const operatorPaymentAttemptSchema = z.object({
  id: z.string().uuid(), reservationId: z.string().uuid(), reference: z.string().min(1).max(200),
  provider: z.string().min(1).max(200), method: z.string().min(1).max(100),
  amountMinor: z.number().int().safe().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
  status: bookingReservationPaymentAttemptStatusSchema,
  providerRef: z.string().min(1).max(200).nullable(),
  successKind: z.enum(['winning', 'late', 'excess']).nullable(),
  expiresAt: z.string().datetime(), succeededAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const listOperatorBookingPaymentAttemptsOutputSchema = z.object({
  items: z.array(operatorPaymentAttemptSchema), total: z.number().int().nonnegative(),
}).strict();

export const listOperatorBookingPaymentAttemptsQuery = defineQuery({
  name: 'booking.reservation.listOperatorPaymentAttempts',
  summary: 'Read bounded, correlated payment-attempt evidence for a human operator',
  input: listOperatorBookingPaymentAttemptsInputSchema,
  output: listOperatorBookingPaymentAttemptsOutputSchema,
  permission: 'booking-reservation:operator-read',
});

function paymentEvidence(row: BookingReservationPaymentAttemptRow) {
  return {
    id: row.id, reservationId: row.reservationId, reference: row.reference,
    provider: row.provider, method: row.method, amountMinor: row.amountMinor, currency: row.currency,
    status: row.status, providerRef: row.providerRef, successKind: row.successKind,
    expiresAt: row.expiresAt.toISOString(), succeededAt: row.succeededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listOperatorBookingPaymentAttemptsHandler(
  input: z.output<typeof listOperatorBookingPaymentAttemptsInputSchema>, context: QueryContext,
) {
  requireBookingReservationOperator(context.actor);
  await requireBookingReservation(context.db, input.reservationId);
  const result = await repository.listOperatorPaymentAttempts(context.db, input);
  return { items: result.items.map(paymentEvidence), total: result.total };
}
