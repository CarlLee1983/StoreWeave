import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { bookingQuoteSchema } from '@storeweave/booking-availability';
import { z } from 'zod';
import { ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB } from './jobs';
import { BookingReservationRepository } from './repository';
import { evaluateReservationRetentionEligibility } from './retention-date';

export const BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE = 100;

export const bookingReservationRetentionPolicySchema = z.object({
  reservationPiiRetentionDays: z.number().int().safe().min(1),
}).strict();

export type BookingReservationRetentionPolicy = z.infer<typeof bookingReservationRetentionPolicySchema>;

export const anonymizeExpiredBookingReservationPiiInputSchema = z.object({
  afterId: z.string().uuid().nullable(),
  runId: z.string().uuid(),
  bucket: z.number().int(),
  scheduledFor: z.string().datetime(),
}).strict();

export const anonymizeExpiredBookingReservationPiiOutputSchema = z.object({
  scanned: z.number().int().min(0).max(BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE),
  anonymized: z.number().int().min(0).max(BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE),
  invalidRows: z.number().int().min(0).max(BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE),
  nextId: z.string().uuid().nullable(),
  hasMore: z.boolean(),
}).strict();

export const anonymizeExpiredBookingReservationPiiCommand = defineCommand({
  name: 'booking.reservation.anonymizeExpiredPii',
  summary: '依設定匿名化超過保存期限的 Reservation 個資',
  input: anonymizeExpiredBookingReservationPiiInputSchema,
  output: anonymizeExpiredBookingReservationPiiOutputSchema,
  permission: 'booking-reservation:retention-write',
  idempotency: 'required',
});

const retentionSnapshotSchema = bookingQuoteSchema.shape.cancellationPolicy;
const piiFields = ['bookerName', 'bookerEmail', 'bookerPhone', 'primaryGuestName', 'accommodationNotes'] as const;

export function createAnonymizeExpiredBookingReservationPiiHandler(
  retentionPolicy: BookingReservationRetentionPolicy,
  repository = new BookingReservationRepository(),
) {
  const policy = bookingReservationRetentionPolicySchema.parse(retentionPolicy);
  return async (input: typeof anonymizeExpiredBookingReservationPiiInputSchema._output, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system worker may anonymize expired Reservation PII');

    const reservations = await repository.lockRetentionBatch(
      context.tx, input.afterId, BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE,
    );
    const now = await repository.databaseNow(context.tx);
    let anonymized = 0;
    let invalidRows = 0;

    for (const reservation of reservations) {
      const snapshot = retentionSnapshotSchema.safeParse(reservation.cancellationPolicy);
      if (!snapshot.success) {
        invalidRows += 1;
        context.logger.warn({ reservationId: reservation.id, reason: 'invalid-retention-facts' }, 'Reservation retention facts are invalid; PII was not changed');
        continue;
      }

      const eligibility = evaluateReservationRetentionEligibility({
        checkOutLocalDate: reservation.checkOutLocalDate,
        propertyTimeZone: snapshot.data.propertyTimeZone,
        reservationPiiRetentionDays: policy.reservationPiiRetentionDays,
        now,
      });
      if (eligibility.kind === 'invalid') {
        invalidRows += 1;
        context.logger.warn({ reservationId: reservation.id, reason: 'invalid-retention-cutoff' }, 'Reservation retention cutoff is invalid; PII was not changed');
        continue;
      }
      if (eligibility.kind === 'ineligible') continue;

      const updated = await repository.anonymizeReservationPii(context.tx, reservation.id, now);
      if (!updated) continue;
      await context.audit({
        action: 'booking.reservation.pii-anonymized',
        resourceType: 'booking_reservation',
        resourceId: reservation.id,
        payload: {
          retentionDays: policy.reservationPiiRetentionDays,
          checkOutLocalDate: reservation.checkOutLocalDate,
          eligibleOnLocalDate: eligibility.eligibleOnLocalDate,
          redactedFields: piiFields,
          ownershipUnlinked: true,
          managementAccessRevoked: true,
        },
      });
      anonymized += 1;
    }

    const nextId = reservations.at(-1)?.id ?? input.afterId;
    const result = {
      scanned: reservations.length,
      anonymized,
      invalidRows,
      nextId,
      hasMore: reservations.length === BOOKING_RESERVATION_PII_RETENTION_BATCH_SIZE,
    };
    if (result.hasMore) {
      if (result.nextId === null || result.nextId === input.afterId) {
        throw new Error('Reservation retention batch did not advance its cursor');
      }
      await context.enqueue({
        type: ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB,
        payload: {
          bucket: input.bucket,
          scheduledFor: input.scheduledFor,
          runId: input.runId,
          afterId: result.nextId,
        },
        dedupeKey: `booking-reservation:retention:${input.runId}:${result.nextId}`,
      });
    }
    return result;
  };
}
