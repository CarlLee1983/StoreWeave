import { describe, expect, it } from 'vitest';
import {
  bookingReservationCancelledV1,
  bookingReservationConfirmedV1,
  bookingReservationPaymentExpiringV1,
} from '../src/events';
import { BOOKING_RESERVATION_NOTIFICATION_TEMPLATES } from '../src/notification-templates';
import {
  materializeBookingReservationNotificationInputSchema,
  bookingReservationNotificationLinkSchema,
} from '../src/types';
import {
  createMaterializeBookingReservationNotificationHandler,
  createRecordBookingReservationNotificationMappingFailureHandler,
} from '../src/notifications';

const reservationId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';
const now = new Date('2026-09-22T00:00:00.000Z');
const currentReservation = {
  id: reservationId, status: 'pending_payment', winningPaymentAttemptId: null,
  paymentExpiresAt: new Date('2026-09-23T00:00:00.000Z'), bookerEmail: 'booker@example.test', bookerName: 'Booker',
};

function link(values: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000004', reservationId, eventId, kind: 'payment-expiring',
    templateId: 'booking.reservation.payment-expiring', reference: `booking-reservation:${eventId}:booking.reservation.payment-expiring`,
    mappingStatus: 'pending', mappingFailureCode: null, createdAt: now, updatedAt: now, ...values,
  };
}

function context() {
  return {
    actor: { id: 'system:test', type: 'system', displayName: 'System', permissions: ['booking-reservation:system-write'] },
    tx: {}, now, enqueue: async () => undefined, publish: async () => undefined, audit: async () => undefined,
    logger: {} as never, correlationId: 'notification-test',
  } as never;
}

describe('Booking Reservation notification contracts', () => {
  it('keeps domain event payloads PII-free and gives deferred payment an exact stale guard', () => {
    expect(bookingReservationConfirmedV1.payload.parse({ reservationId, paymentAttemptId: attemptId, confirmedAt: new Date() }))
      .toEqual(expect.objectContaining({ reservationId, paymentAttemptId: attemptId }));
    expect(bookingReservationCancelledV1.payload.parse({ reservationId, cancelledAt: new Date() }))
      .toEqual(expect.objectContaining({ reservationId }));
    expect(bookingReservationPaymentExpiringV1.payload.parse({ reservationId, paymentAttemptId: attemptId, expiresAt: new Date() }))
      .toEqual(expect.objectContaining({ reservationId, paymentAttemptId: attemptId }));
    expect(bookingReservationConfirmedV1.payload.safeParse({ reservationId, paymentAttemptId: attemptId, confirmedAt: new Date(), email: 'leak@example.test' }).success).toBe(false);
    expect(materializeBookingReservationNotificationInputSchema.safeParse({
      eventId, kind: 'payment-expiring', reservationId, paymentAttemptId: attemptId,
    }).success).toBe(false);
  });

  it('uses a transient access grant in Booking-owned content and never names a management credential', () => {
    for (const template of Object.values(BOOKING_RESERVATION_NOTIFICATION_TEMPLATES)) {
      const content = `${template.email?.subject}\n${template.email?.text}\n${template.email?.html}`;
      expect(content).toContain('{accessGrant}');
      expect(content).toContain('{accessGrantExpiresAt}');
      expect(content).not.toMatch(/management(?:Credential|Token)/i);
    }
  });

  it('exposes only fixed mapping-failure evidence, never a provider error body', () => {
    expect(bookingReservationNotificationLinkSchema.safeParse({
      id: reservationId, reservationId, eventId, kind: 'confirmed', templateId: 'booking.reservation.confirmed',
      reference: `booking-reservation:${eventId}:booking.reservation.confirmed`, mappingStatus: 'mapping_failed',
      mappingFailureCode: 'booker_unavailable', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).success).toBe(true);
    expect(bookingReservationNotificationLinkSchema.safeParse({
      id: reservationId, reservationId, eventId, kind: 'confirmed', templateId: 'booking.reservation.confirmed',
      reference: `booking-reservation:${eventId}:booking.reservation.confirmed`, mappingStatus: 'mapping_failed',
      mappingFailureCode: 'SMTP rejected recipient@example.test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).success).toBe(false);
  });

  it('supersedes a stale event without issuing a grant or asking Base to deliver', async () => {
    const stale = { ...currentReservation, status: 'confirmed', winningPaymentAttemptId: attemptId };
    const calls = { grants: 0, sends: 0 };
    const links = {
      findNotificationLinkByEventTemplate: async () => undefined,
      lockById: async () => stale,
      lockPaymentAttemptsForReservation: async () => [{ id: attemptId, status: 'awaiting_payment', expiresAt: stale.paymentExpiresAt }],
      insertNotificationLink: async (_tx: unknown, values: Record<string, unknown>) => link(values),
      updateNotificationLink: async () => undefined,
    };
    const handler = createMaterializeBookingReservationNotificationHandler({
      access: { issueGrant: async () => { calls.grants += 1; throw new Error('must not issue'); } },
      notifications: () => ({ send: async () => { calls.sends += 1; throw new Error('must not send'); } }) as never,
      locale: 'en',
    }, links as never);
    const result = await handler({
      eventId, kind: 'payment-expiring', reservationId, paymentAttemptId: attemptId,
      expiresAt: currentReservation.paymentExpiresAt.toISOString(),
    }, context());
    expect(result.mappingStatus).toBe('superseded');
    expect(calls).toEqual({ grants: 0, sends: 0 });
  });

  it('sends only a transient Access Grant to Base and records a safe failure separately', async () => {
    let stored: ReturnType<typeof link> | undefined;
    let baseInput: Record<string, unknown> | undefined;
    const links = {
      findNotificationLinkByEventTemplate: async () => stored,
      lockById: async () => currentReservation,
      lockPaymentAttemptsForReservation: async () => [{ id: attemptId, status: 'awaiting_payment', expiresAt: currentReservation.paymentExpiresAt }],
      insertNotificationLink: async (_tx: unknown, values: Record<string, unknown>) => { stored = link(values); return stored; },
      updateNotificationLink: async (_tx: unknown, _id: string, values: Record<string, unknown>) => { stored = link({ ...stored, ...values }); return stored; },
    };
    const handler = createMaterializeBookingReservationNotificationHandler({
      access: { issueGrant: async () => ({ grantToken: 'signed-grant-only', expiresAt: new Date('2026-09-22T00:15:00.000Z'), generation: 1 }) },
      notifications: () => ({ send: async (_tx: unknown, input: Record<string, unknown>) => { baseInput = input; return {}; } }) as never,
      locale: 'en',
    }, links as never);
    const input = { eventId, kind: 'payment-expiring' as const, reservationId, paymentAttemptId: attemptId, expiresAt: currentReservation.paymentExpiresAt.toISOString() };
    await expect(handler(input, context())).resolves.toMatchObject({ mappingStatus: 'requested' });
    expect(baseInput).toMatchObject({ reference: `booking-reservation:${eventId}:booking.reservation.payment-expiring` });
    expect(baseInput?.variables).toMatchObject({ accessGrant: 'signed-grant-only' });
    expect(JSON.stringify(baseInput)).not.toMatch(/management(?:Credential|Token)/i);
    expect(JSON.stringify(stored)).not.toContain('signed-grant-only');

    // A failed materializer transaction leaves no link; the subscriber's second
    // system command records only its fixed operational code.
    stored = undefined;
    const failure = createRecordBookingReservationNotificationMappingFailureHandler(links as never);
    await expect(failure({ eventId, reservationId, kind: 'payment-expiring', failure: 'permanent' }, context())).resolves.toMatchObject({
      mappingStatus: 'mapping_failed', mappingFailureCode: 'booker_unavailable',
    });
  });

  it('lets a concurrent replay converge on the event/template link and one Base request', async () => {
    let stored: ReturnType<typeof link> | undefined;
    let sends = 0;
    const links = {
      findNotificationLinkByEventTemplate: async () => stored,
      lockById: async () => currentReservation,
      lockPaymentAttemptsForReservation: async () => [{ id: attemptId, status: 'awaiting_payment', expiresAt: currentReservation.paymentExpiresAt }],
      insertNotificationLink: async (_tx: unknown, values: Record<string, unknown>) => {
        if (stored) return undefined;
        stored = link(values);
        return stored;
      },
      updateNotificationLink: async (_tx: unknown, _id: string, values: Record<string, unknown>) => {
        stored = link({ ...stored, ...values });
        return stored;
      },
    };
    const handler = createMaterializeBookingReservationNotificationHandler({
      access: { issueGrant: async () => ({ grantToken: 'grant', expiresAt: new Date('2026-09-22T00:15:00.000Z'), generation: 1 }) },
      notifications: () => ({ send: async () => { sends += 1; return {}; } }) as never,
      locale: 'en',
    }, links as never);
    const input = { eventId, kind: 'payment-expiring' as const, reservationId, paymentAttemptId: attemptId, expiresAt: currentReservation.paymentExpiresAt.toISOString() };
    const [first, second] = await Promise.all([handler(input, context()), handler(input, context())]);
    expect(first.reference).toBe(second.reference);
    expect(sends).toBe(1);
  });
});
