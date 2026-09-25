import { z } from 'zod';
import { DEFAULT_JOB_MAX_ATTEMPTS, PermanentJobError, type JobContext, type JobHandler } from '@storeweave/jobs';
import type { BookingReservationPaymentProvider } from './payment-attempts';
import { getBookingReservationPaymentAttemptForProcessingOutputSchema, getBookingReservationRefundForProcessingOutputSchema } from './types';

export const EXPIRE_BOOKING_RESERVATION_JOB = 'booking.reservation.expire';
export const ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB = 'booking.reservation.anonymize-expired-pii';
export const PROCESS_BOOKING_RESERVATION_PAYMENT_JOB = 'booking.reservation.process-payment';
export const PROCESS_BOOKING_RESERVATION_REFUND_JOB = 'booking.reservation.process-refund';
export const RECONCILE_BOOKING_RESERVATION_REFUNDS_JOB = 'booking.reservation.reconcile-refunds';
export const RECONCILE_BOOKING_RESERVATION_LATE_NOTIFICATIONS_JOB = 'booking.reservation.reconcile-late-notifications';

export const processBookingReservationPaymentJobPayload = z.object({
  attemptId: z.string().uuid(),
  reservationId: z.string().uuid(),
  provider: z.string().min(1).max(200),
  reference: z.string().min(1).max(200),
}).strict();

export const processBookingReservationRefundJobPayload = z.object({
  refundId: z.string().uuid(), generation: z.number().int().positive(),
}).strict();
export const reconcileBookingReservationRefundsJobPayload = z.object({}).strict();
export const reconcileLatePaymentNotificationsJobPayload = z.union([
  z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict(),
  z.object({ cutoff: z.string().datetime(), afterAttemptId: z.string().uuid() }).strict(),
]);

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

type CoreJobContext = Pick<JobContext, 'attempt' | 'executeCommand' | 'executeQuery'>;

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
  };
}

export function createProcessBookingReservationRefundJob(provider: BookingReservationPaymentProvider): JobHandler {
  return async (rawPayload, rawContext) => {
    const payload = processBookingReservationRefundJobPayload.parse(rawPayload);
    const context = rawContext as CoreJobContext;
    if (!context.executeCommand || !context.executeQuery) throw new Error('Reservation refund job requires the core command and query bridges');
    const preflight = getBookingReservationRefundForProcessingOutputSchema.parse(await context.executeQuery(
      'booking.reservation.getRefundForProcessing', payload,
    ));
    if (preflight.kind === 'noop') return;
    if (preflight.provider !== provider.id) {
      await context.executeCommand('booking.reservation.recordRefundInvocation', {
        refundId: payload.refundId, generation: payload.generation, workerAttempt: preflight.workerAttempt,
        result: { status: 'indeterminate', final: true, message: 'Configured refund provider does not match persisted refund evidence' },
      }, `booking-reservation:refund-provider-mismatch:${payload.refundId}:${payload.generation}:${preflight.workerAttempt}`);
      throw new PermanentJobError(`Reservation refund ${payload.refundId} requires provider ${preflight.provider}`);
    }
    try {
      // Provider I/O is intentionally out of the transaction. The immutable
      // header reference is reused after a crash or response loss.
      const result = await provider.refund(preflight.request);
      await context.executeCommand('booking.reservation.recordRefundInvocation', {
        refundId: payload.refundId, generation: payload.generation, workerAttempt: preflight.workerAttempt, result,
      }, `booking-reservation:refund-result:${payload.refundId}:${payload.generation}:${preflight.workerAttempt}`);
    } catch (error) {
      // Do not turn arbitrary adapter/transport error text into durable
      // operator-visible data. It can contain secrets and may violate the
      // bounded command schema; the invocation still records the uncertainty.
      const message = 'Provider refund transport failed';
      await context.executeCommand('booking.reservation.recordRefundInvocation', {
        refundId: payload.refundId, generation: payload.generation, workerAttempt: preflight.workerAttempt,
        result: { status: 'indeterminate', message, final: rawContext.attempt >= DEFAULT_JOB_MAX_ATTEMPTS },
      }, `booking-reservation:refund-indeterminate:${payload.refundId}:${payload.generation}:${preflight.workerAttempt}`);
      throw error;
    }
  };
}

export function createReconcileBookingReservationRefundsJob(): JobHandler {
  return async (_payload, rawContext) => {
    const context = rawContext as CoreJobContext;
    if (!context.executeCommand) throw new Error('Reservation refund reconciler requires the core command bridge');
    await context.executeCommand('booking.reservation.reconcileRefunds', {}, `booking-reservation:refund-reconcile:${rawContext.occurrenceId}`);
  };
}

export function createReconcileLatePaymentNotificationsJob(): JobHandler {
  return async (rawPayload, rawContext) => {
    const payload = reconcileLatePaymentNotificationsJobPayload.parse(rawPayload);
    const context = rawContext as CoreJobContext;
    if (!context.executeCommand) throw new Error('Late Payment notification reconciler requires the core command bridge');
    await context.executeCommand('booking.reservation.reconcileLatePaymentNotifications', {
      cutoff: 'scheduledFor' in payload ? payload.scheduledFor : payload.cutoff,
      ...('afterAttemptId' in payload ? { afterAttemptId: payload.afterAttemptId } : {}),
      limit: 100,
    }, `booking-reservation:late-notification-reconcile:${rawContext.occurrenceId}`);
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
