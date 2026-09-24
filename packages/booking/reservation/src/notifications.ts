import { randomUUID } from 'node:crypto';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { NotificationsPort } from '@storeweave/notifications';
import type { BookingReservationAccess } from './access';
import { BOOKING_RESERVATION_NOTIFICATION_TEMPLATES } from './notification-templates';
import { BookingReservationRepository } from './repository';
import { requireBookingReservation, requireBookingReservationOperator } from './operator-read';
import {
  bookingReservationNotificationLinkSchema,
  listBookingReservationNotificationsInputSchema,
  listBookingReservationNotificationsOutputSchema,
  materializeBookingReservationNotificationInputSchema,
  materializeBookingReservationNotificationOutputSchema,
  recordBookingReservationNotificationMappingFailureInputSchema,
  recordBookingReservationNotificationMappingFailureOutputSchema,
  type BookingReservationNotificationKind,
  type BookingReservationNotificationLink,
  type BookingReservationNotificationTemplateId,
  type MaterializeBookingReservationNotificationInput,
} from './types';

const repository = new BookingReservationRepository();
const ACCESS_GRANT_TTL_MS = 15 * 60_000;

/** Only an impossible Booker snapshot is terminal at this boundary. */
export class PermanentBookingReservationNotificationMappingError extends Error {}

function templateFor(kind: BookingReservationNotificationKind): BookingReservationNotificationTemplateId {
  switch (kind) {
    case 'confirmed': return 'booking.reservation.confirmed';
    case 'cancelled': return 'booking.reservation.cancelled';
    case 'payment-expiring': return 'booking.reservation.payment-expiring';
  }
}

function referenceFor(eventId: string, templateId: BookingReservationNotificationTemplateId): string {
  return `booking-reservation:${eventId}:${templateId}`;
}

function toLink(row: {
  id: string; reservationId: string; eventId: string; kind: string; templateId: string; reference: string;
  mappingStatus: string; mappingFailureCode: string | null; createdAt: Date; updatedAt: Date;
}): BookingReservationNotificationLink {
  return bookingReservationNotificationLinkSchema.parse({
    ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}

function isCurrent(input: MaterializeBookingReservationNotificationInput, reservation: {
  status: string; winningPaymentAttemptId: string | null; paymentExpiresAt: Date;
}, attempts: readonly { id: string; status: string; expiresAt: Date }[]): boolean {
  switch (input.kind) {
    case 'confirmed':
      return reservation.status === 'confirmed' && reservation.winningPaymentAttemptId === input.paymentAttemptId;
    case 'cancelled':
      return reservation.status === 'cancelled';
    case 'payment-expiring': {
      const attempt = attempts.find(candidate => candidate.id === input.paymentAttemptId);
      return reservation.status === 'pending_payment'
        && attempt?.status === 'awaiting_payment'
        && attempt.expiresAt.getTime() === new Date(input.expiresAt).getTime();
    }
  }
}

export const materializeBookingReservationNotificationCommand = defineCommand({
  name: 'booking.reservation.materializeNotification',
  summary: 'Materialize one current Reservation notification through the Base capability',
  input: materializeBookingReservationNotificationInputSchema,
  output: materializeBookingReservationNotificationOutputSchema,
  permission: 'booking-reservation:system-write',
  idempotency: 'required',
});

export const recordBookingReservationNotificationMappingFailureCommand = defineCommand({
  name: 'booking.reservation.recordNotificationMappingFailure',
  summary: 'Record a safe operator-visible Reservation notification mapping failure',
  input: recordBookingReservationNotificationMappingFailureInputSchema,
  output: recordBookingReservationNotificationMappingFailureOutputSchema,
  permission: 'booking-reservation:system-write',
  idempotency: 'required',
});

export const listBookingReservationNotificationsQuery = defineQuery({
  name: 'booking.reservation.listNotifications',
  summary: 'List Reservation notification mapping and masked Base delivery evidence',
  input: listBookingReservationNotificationsInputSchema,
  output: listBookingReservationNotificationsOutputSchema,
  permission: 'booking-reservation:notification-read',
});

export interface BookingReservationNotificationDeps {
  readonly access: Pick<BookingReservationAccess, 'issueGrant'>;
  readonly notifications: () => NotificationsPort;
  readonly locale: string;
}

/**
 * The event is deliberately revalidated after outbox delay. Old deferred-payment
 * notices are durable evidence, but must not issue a grant or send content.
 */
export function createMaterializeBookingReservationNotificationHandler(
  deps: BookingReservationNotificationDeps,
  links: BookingReservationRepository = repository,
) {
  return async (input: MaterializeBookingReservationNotificationInput, context: CommandContext): Promise<BookingReservationNotificationLink> => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system event subscriber may materialize a Reservation notification');
    const templateId = templateFor(input.kind);
    const existing = await links.findNotificationLinkByEventTemplate(context.tx, input.eventId, templateId);
    if (existing && existing.mappingStatus !== 'mapping_retryable') return toLink(existing);

    const reservation = await links.lockById(context.tx, input.reservationId);
    if (!reservation) throw PlatformError.notFound('Reservation', input.reservationId);
    const attempts = input.kind === 'payment-expiring'
      ? await links.lockPaymentAttemptsForReservation(context.tx, reservation.id)
      : [];
    const reference = referenceFor(input.eventId, templateId);
    const current = isCurrent(input, reservation, attempts);
    const inserted = existing ?? await links.insertNotificationLink(context.tx, {
      id: randomUUID(), reservationId: reservation.id, eventId: input.eventId, kind: input.kind,
      templateId, reference, mappingStatus: current ? 'pending' : 'superseded',
      mappingFailureCode: null, createdAt: context.now, updatedAt: context.now,
    });
    if (!inserted) {
      const concurrent = await links.findNotificationLinkByEventTemplate(context.tx, input.eventId, templateId);
      if (!concurrent) throw PlatformError.internal('Reservation notification link disappeared');
      return toLink(concurrent);
    }
    if (!current) {
      const superseded = await links.updateNotificationLink(context.tx, inserted.id, {
        mappingStatus: 'superseded', mappingFailureCode: null,
      }, context.now);
      return toLink(superseded ?? inserted);
    }
    if (!reservation.bookerEmail) {
      throw new PermanentBookingReservationNotificationMappingError(`Reservation ${reservation.id} no longer has a Booker email`);
    }

    // This is the only access operation notification materialization receives:
    // a raw management credential cannot be created, redeemed, or persisted here.
    const grant = await deps.access.issueGrant(context.tx, { reservationId: reservation.id, ttlMs: ACCESS_GRANT_TTL_MS });
    const template = BOOKING_RESERVATION_NOTIFICATION_TEMPLATES[templateId];
    const variables: Record<string, unknown> = {
      reservationId: reservation.id,
      accessGrant: grant.grantToken,
      accessGrantExpiresAt: grant.expiresAt.toISOString(),
      ...(input.kind === 'payment-expiring' ? { paymentExpiresAt: input.expiresAt } : {}),
    };
    await deps.notifications().send(context.tx, {
      reference, channels: ['email'], locale: deps.locale,
      recipient: { email: reservation.bookerEmail, ...(reservation.bookerName ? { name: reservation.bookerName } : {}) },
      template, variables,
    }, job => context.enqueue(job), context.now);
    const requested = await links.updateNotificationLink(context.tx, inserted.id, {
      mappingStatus: 'requested', mappingFailureCode: null,
    }, context.now);
    if (!requested) throw PlatformError.internal('Reservation notification link disappeared after Base request');
    return toLink(requested);
  };
}

/** Called by the subscriber only after the materializer transaction has rolled back. */
export function createRecordBookingReservationNotificationMappingFailureHandler(links: BookingReservationRepository = repository) {
  return async (input: { eventId: string; reservationId: string; kind: BookingReservationNotificationKind; failure: 'permanent' | 'retryable' }, context: CommandContext): Promise<BookingReservationNotificationLink> => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system event subscriber may record notification mapping failure');
    const templateId = templateFor(input.kind);
    const existing = await links.findNotificationLinkByEventTemplate(context.tx, input.eventId, templateId);
    if (existing) {
      // A retry can discover that a previously transient dependency error was
      // masking a terminal Booker defect. Do not let the first failure's
      // idempotency identity hide that durable operational conclusion.
      if (existing.mappingStatus === 'mapping_retryable' && input.failure === 'permanent') {
        const terminal = await links.updateNotificationLink(context.tx, existing.id, {
          mappingStatus: 'mapping_failed', mappingFailureCode: 'booker_unavailable',
        }, context.now);
        if (!terminal) throw PlatformError.internal('Reservation notification retryable link disappeared');
        return toLink(terminal);
      }
      return toLink(existing);
    }
    const reservation = await links.lockById(context.tx, input.reservationId);
    if (!reservation) throw PlatformError.notFound('Reservation', input.reservationId);
    const reference = referenceFor(input.eventId, templateId);
    const inserted = await links.insertNotificationLink(context.tx, {
      id: randomUUID(), reservationId: reservation.id, eventId: input.eventId, kind: input.kind,
      templateId, reference,
      mappingStatus: input.failure === 'permanent' ? 'mapping_failed' : 'mapping_retryable',
      mappingFailureCode: input.failure === 'permanent' ? 'booker_unavailable' : 'materialization_retryable',
      createdAt: context.now, updatedAt: context.now,
    });
    if (inserted) return toLink(inserted);
    const concurrent = await links.findNotificationLinkByEventTemplate(context.tx, input.eventId, templateId);
    if (!concurrent) throw PlatformError.internal('Reservation notification mapping failure link disappeared');
    return toLink(concurrent);
  };
}

export function createListBookingReservationNotificationsHandler(notifications: () => NotificationsPort) {
  return async (input: { reservationId: string; limit: number; offset: number }, context: QueryContext) => {
    requireBookingReservationOperator(context.actor);
    await requireBookingReservation(context.db, input.reservationId);
    const result = await repository.listNotificationLinks(context.db, input);
    const evidence = await notifications().evidenceByReference(result.items.map(item => item.reference));
    return {
      items: result.items.map(item => ({
        ...toLink(item),
        deliveries: (evidence.get(item.reference) ?? []).map(delivery => ({
          id: delivery.id, notificationId: delivery.notificationId,
          templateId: delivery.templateId, templateVersion: delivery.templateVersion,
          channel: delivery.channel, status: delivery.status, attempts: delivery.attempts,
          recipientMasked: delivery.recipientMasked, sentAt: delivery.sentAt,
          createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
        })),
      })),
      total: result.total,
    };
  };
}
