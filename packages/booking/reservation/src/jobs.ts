import { z } from 'zod';
import { PermanentJobError, type JobContext, type JobHandler } from '@storeweave/jobs';
import type { BookingReservationPaymentProvider } from './payment-attempts';
import { getBookingReservationPaymentAttemptForProcessingOutputSchema } from './types';

export const EXPIRE_BOOKING_RESERVATION_JOB = 'booking.reservation.expire';
export const ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB = 'booking.reservation.anonymize-expired-pii';
export const PROCESS_BOOKING_RESERVATION_PAYMENT_JOB = 'booking.reservation.process-payment';

export const processBookingReservationPaymentJobPayload = z.object({
  attemptId: z.string().uuid(),
  reservationId: z.string().uuid(),
  provider: z.string().min(1).max(200),
  reference: z.string().min(1).max(200),
}).strict();

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

type CoreJobContext = Pick<JobContext, 'executeCommand' | 'executeQuery'>;

export function createProcessBookingReservationPaymentJob(provider: BookingReservationPaymentProvider): JobHandler {
  return async (rawPayload, rawContext) => {
    const payload = processBookingReservationPaymentJobPayload.parse(rawPayload);
    const context = rawContext as CoreJobContext;
    if (!context.executeCommand || !context.executeQuery) throw new Error('Reservation payment job requires the core command and query bridges');
    if (payload.provider !== provider.id) {
      throw new PermanentJobError(`Reservation payment attempt ${payload.attemptId} requires provider ${payload.provider}`);
    }
    const preflight = getBookingReservationPaymentAttemptForProcessingOutputSchema.parse(await context.executeQuery(
      'booking.reservation.getPaymentAttemptForProcessing',
      { attemptId: payload.attemptId, provider: payload.provider, reference: payload.reference },
    ));
    if (preflight.kind === 'noop') return;

    // This is deliberately outside the command transaction. The stable attempt
    // reference lets a provider replay safely after a worker crash or timeout.
    const result = await provider.initiate(preflight.request);
    await context.executeCommand(
      'booking.reservation.recordPaymentResult',
      { attemptId: payload.attemptId, provider: provider.id, result },
      `booking-reservation:payment-result:${provider.id}:${payload.attemptId}:${result.status}:${'providerRef' in result ? result.providerRef ?? 'none' : 'none'}`,
    );
    if (result.status === 'confirmed') {
      throw new PermanentJobError('Synchronous Booking payment confirmation requires SW-128 winner selection');
    }
  };
}

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
