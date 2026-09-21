import { z } from 'zod';
import type { JobContext, JobHandler } from '@storeweave/jobs';

export const EXPIRE_BOOKING_RESERVATION_JOB = 'booking.reservation.expire';
export const ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB = 'booking.reservation.anonymize-expired-pii';

export const anonymizeExpiredBookingReservationPiiJobPayload = z.object({
  bucket: z.number().int(),
  scheduledFor: z.string().datetime(),
  runId: z.string().uuid().optional(),
  afterId: z.string().uuid().optional(),
}).strict().refine(
  payload => (payload.runId === undefined) === (payload.afterId === undefined),
  'Retention continuation payloads require both a stable run id and a cursor',
);

export const expireBookingReservationJobPayload = z.object({
  reservationId: z.string().uuid(),
  expectedPaymentExpiresAt: z.string().datetime(),
}).strict();

type CoreJobContext = Pick<JobContext, 'executeCommand'>;

export function createExpireBookingReservationJob(): JobHandler {
  return async (rawPayload, rawContext) => {
    const { reservationId, expectedPaymentExpiresAt } = expireBookingReservationJobPayload.parse(rawPayload);
    const context = rawContext as CoreJobContext;
    if (!context.executeCommand) throw new Error('Reservation expiry job requires the core command bridge');

    await context.executeCommand(
      'booking.reservation.expire',
      { reservationId, expectedPaymentExpiresAt },
      `booking-reservation:expire:${reservationId}:${expectedPaymentExpiresAt}`,
    );
  };
}

export function createAnonymizeExpiredBookingReservationPiiJob(): JobHandler {
  return async (rawPayload, rawContext) => {
    const payload = anonymizeExpiredBookingReservationPiiJobPayload.parse(rawPayload);
    const context = rawContext as JobContext;
    if (!context.executeCommand) throw new Error('Reservation retention job requires the core command bridge');
    if (context.signal.aborted) throw context.signal.reason ?? new Error('Reservation retention job was cancelled');

    await context.executeCommand(
      'booking.reservation.anonymizeExpiredPii',
      {
        afterId: payload.afterId ?? null,
        runId: payload.runId ?? context.occurrenceId,
        bucket: payload.bucket,
        scheduledFor: payload.scheduledFor,
      },
      `booking-reservation:retention-command:${payload.runId ?? context.occurrenceId}:${payload.afterId ?? 'start'}`,
    );
  };
}
