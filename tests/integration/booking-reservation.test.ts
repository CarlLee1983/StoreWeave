import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, SYSTEM_ACTOR, type Actor, type CommandContext } from '@storeweave/contracts';
import { sha256Hex, signValue, type Keyring } from '@storeweave/crypto';
import type { PaymentInitiationInput, PaymentInitiationResult, PaymentMethod, PaymentProviderV2, PaymentRefundInputV2, PaymentRefundResult } from '@storeweave/extension-sdk';
import { bindModuleCapability, createRuntime, resolveKeyring, Worker, type Runtime } from '@storeweave/kernel';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bindBookingAvailabilityQuoteReservation, createBookingAvailabilityModule,
  BOOKING_PROPERTY_READ_CAPABILITY,
} from '../../packages/booking/availability/src/module';
import {
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  bookingAvailabilityRoomNightOperations,
  type BookingAvailabilityRoomNightOperations,
} from '../../packages/booking/availability/src/room-night-operations';
import type { BookingQuote } from '../../packages/booking/availability/src/quote';
import { bookingPropertyRead } from '../../packages/booking/property/src/service';
import { createBookingPropertyModule } from '../../packages/booking/property/src/module';
import {
  BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
  createBookingReservationAccess,
  type BookingReservationAccess,
} from '../../packages/booking/reservation/src/access';
import { bookingReservationMigrations } from '../../packages/booking/reservation/src/migrations';
import { authorizeResendBookingReservationAccessGrant } from '../../packages/booking/reservation/src/management';
import { createBookingReservationModule } from '../../packages/booking/reservation/src/module';
import { createRequiredBookingReservationRefund } from '../../packages/booking/reservation/src/refunds';

const actor = (permissions: string[]): Actor => ({
  id: 'test:booking-reservation', type: 'user', displayName: 'Booking Reservation Test', permissions,
});

describe('SW-154 operator Reservation read', () => {
  const operator = actor([
    'booking-reservation:operator-read', 'booking-reservation:refund-read',
    'booking-reservation:notification-read',
  ]);

  it('pages equal-timestamp Reservations deterministically and keeps list PII-free after retention', async () => {
    const { roomType, reservation } = await createReservation('sw154-list');
    const cloneIds = await cloneReservations(reservation.id, 3);
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET created_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [cloneIds]);
    const detail = await runtime.queries.execute<any>('booking.reservation.getOperator',
      { reservationId: reservation.id }, { actor: operator });
    expect(detail.reservation).toMatchObject({
      id: reservation.id,
      booker: { name: 'Private Booker Name', email: 'private.booker@example.test' },
      primaryGuestName: 'Private Guest Name', accommodationNotes: 'Private arrival note',
    });
    expect(JSON.stringify(detail)).not.toMatch(/managementTokenHash|checkoutCredentialHash|quoteFingerprint|accessGrantNonce/);

    const filter = {
      roomTypeId: roomType.id, status: 'confirmed',
      checkInFrom: detail.reservation.checkInLocalDate, checkInTo: detail.reservation.checkInLocalDate,
    };
    const first = await runtime.queries.execute<any>('booking.reservation.listOperator',
      { ...filter, limit: 2, offset: 0 }, { actor: operator });
    const second = await runtime.queries.execute<any>('booking.reservation.listOperator',
      { ...filter, limit: 2, offset: 2 }, { actor: operator });
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect([...first.items, ...second.items].map(item => item.id)).toEqual([...cloneIds].sort().reverse());
    expect(JSON.stringify(first.items)).not.toMatch(/Private Booker|private\.booker|Private Guest|Private arrival|Token|fingerprint|notes/i);

    await runtime.database.pool.query(`UPDATE booking_reservation_reservations SET
      booker_name = NULL, booker_email = NULL, booker_phone = NULL,
      primary_guest_name = NULL, accommodation_notes = NULL,
      pii_anonymized_at = pg_catalog.clock_timestamp() WHERE id = $1`, [cloneIds[0]]);
    const anonymized = await runtime.queries.execute<any>('booking.reservation.getOperator',
      { reservationId: cloneIds[0] }, { actor: operator });
    expect(anonymized.reservation.booker).toEqual({ name: null, email: null, phone: null });
    expect(anonymized.reservation.primaryGuestName).toBeNull();
    expect(anonymized.reservation.accommodationNotes).toBeNull();

    const index = await runtime.database.pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND indexname = 'booking_reservation_operator_created_idx'`);
    expect(index.rows[0]?.indexdef).toContain('(created_at, id)');
  });

  it('returns bounded Late/Excess payment and failed refund evidence without provider free text', async () => {
    const { reservation } = await createReservation('sw154-evidence');
    const other = await createReservation('sw154-evidence-other');
    const lateId = randomUUID();
    const excessId = randomUUID();
    const lateReference = `sw154-late:${randomUUID()}`;
    const excessReference = `sw154-excess:${randomUUID()}`;
    await runtime.database.pool.query(`INSERT INTO booking_reservation_payment_attempts (
      id, reservation_id, reference, provider, method, amount_minor, currency,
      status, provider_ref, action, instructions, expires_at, failure_message,
      success_kind, succeeded_at, created_at, updated_at
    ) VALUES
      ($1, $3, $4, 'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', $6,
       '{"type":"redirect","url":"https://private.example.test/?token=canary"}'::jsonb,
       '{"code":"private-code"}'::jsonb, now() + interval '1 day', 'provider-message-canary',
       'late', now(), '2026-01-02T00:00:00Z', now()),
      ($2, $3, $5, 'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', $7,
       NULL, NULL, now() + interval '1 day', 'provider-message-canary',
       'excess', now(), '2026-01-02T00:00:00Z', now())`, [
      lateId, excessId, reservation.id, lateReference, excessReference,
      `sw154-provider-late:${lateId}`, `sw154-provider-excess:${excessId}`,
    ]);
    await runtime.database.pool.query(`INSERT INTO booking_reservation_refunds (
      id, reservation_id, payment_attempt_id, reason, provider, payment_provider_ref,
      amount_minor, currency, provider_request_ref, status, failure_kind, failure_message,
      completed_at
    ) VALUES ($1, $2, $3, 'late_payment', 'booking-test-payment', $4,
      24690, 'USD', $5, 'failed', 'rejected', 'refund-message-canary', now())`, [
      randomUUID(), reservation.id, lateId, `sw154-provider-late:${lateId}`, `sw154-refund:${randomUUID()}`,
    ]);

    const attempts = await runtime.queries.execute<any>('booking.reservation.listOperatorPaymentAttempts',
      { reservationId: reservation.id, limit: 1, offset: 0 }, { actor: operator });
    const later = await runtime.queries.execute<any>('booking.reservation.listOperatorPaymentAttempts',
      { reservationId: reservation.id, limit: 1, offset: 1 }, { actor: operator });
    expect(attempts.total).toBe(2);
    expect([...attempts.items, ...later.items].map(item => item.successKind).sort()).toEqual(['excess', 'late']);
    expect([...attempts.items, ...later.items].map(item => item.id)).toEqual([lateId, excessId].sort().reverse());
    expect(JSON.stringify([attempts, later])).not.toMatch(/provider-message-canary|private-code|private\.example|action|instructions|failureMessage/);

    const refunds = await runtime.queries.execute<any>('booking.reservation.listRefunds',
      { reservationId: reservation.id, limit: 1, offset: 0 }, { actor: operator });
    expect(refunds).toMatchObject({ total: 1, items: [{ reason: 'late_payment', status: 'failed', failureKind: 'rejected' }] });
    expect(JSON.stringify(refunds)).not.toMatch(/refund-message-canary|failureMessage/);
    const foreign = await runtime.queries.execute<any>('booking.reservation.listOperatorPaymentAttempts',
      { reservationId: other.reservation.id }, { actor: operator });
    expect(foreign).toEqual({ items: [], total: 0 });
  });

  it('rejects forbidden actors and malformed reads, and distinguishes unknown parents from empty evidence', async () => {
    const { reservation } = await createReservation('sw154-auth');
    const unknownId = randomUUID();
    const scoped = [
      ['booking.reservation.getOperator', { reservationId: reservation.id }],
      ['booking.reservation.listOperatorPaymentAttempts', { reservationId: reservation.id }],
      ['booking.reservation.listRefunds', { reservationId: reservation.id }],
      ['booking.reservation.listNotifications', { reservationId: reservation.id }],
    ] as const;
    await expect(runtime.queries.execute('booking.reservation.listOperator', {}, { actor: actor([]) }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const type of ['service', 'customer', 'extension', 'system'] as const) {
      await expect(runtime.queries.execute('booking.reservation.listOperator', {}, {
        actor: { ...operator, type, permissions: ['*'] },
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    for (const [name, input] of scoped) {
      await expect(runtime.queries.execute(name, input, { actor: actor([]) }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const type of ['service', 'customer', 'extension', 'system'] as const) {
        await expect(runtime.queries.execute(name, input, {
          actor: { ...operator, type, permissions: ['*'] },
        })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      await expect(runtime.queries.execute(name, { reservationId: unknownId }, { actor: operator }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(runtime.queries.execute(name, { reservationId: 'not-a-uuid' }, { actor: operator }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    for (const name of ['booking.reservation.listOperatorPaymentAttempts',
      'booking.reservation.listRefunds', 'booking.reservation.listNotifications']) {
      await expect(runtime.queries.execute(name, { reservationId: reservation.id }, { actor: operator }))
        .resolves.toEqual({ items: [], total: 0 });
      for (const page of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10_001 }]) {
        await expect(runtime.queries.execute(name, { reservationId: reservation.id, ...page }, { actor: operator }))
          .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      }
    }
    for (const invalid of [
      { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10_001 },
      { status: 'invalid' }, { roomTypeId: 'invalid' },
      { checkInFrom: '2026-02-31' },
      { checkInFrom: '2026-10-02', checkInTo: '2026-10-01' },
      { checkInFrom: '2026-01-01', checkInTo: '2027-02-01' },
    ]) {
      await expect(runtime.queries.execute('booking.reservation.listOperator', invalid, { actor: operator }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});
const PROPERTY_MANAGER = actor(['booking-property:manage', 'booking-availability:manage']);
const RESERVATION_ACTOR = actor([
  'booking-property:manage', 'booking-availability:manage', 'booking-availability:quote',
  'booking-reservation:create', 'booking-reservation:pay', 'booking-reservation:claim', 'booking-reservation:read-self',
  'booking-reservation:read-managed', 'booking-reservation:manage-self',
]);
const OPERATOR_ACTOR = actor(['booking-reservation:cancel']);
function signedInAccountActor(accountId = randomUUID(), type: 'user' | 'customer' = 'user'): Actor {
  return {
    id: `user:${accountId}`,
    type,
    displayName: 'Signed-in Booker',
    permissions: RESERVATION_ACTOR.permissions,
  };
}
const TEST_SECRET = Buffer.alloc(32, 9).toString('base64url');
const PROPERTY_TIME_ZONE = 'America/Los_Angeles';
const QUOTE_LIMITS = { maxRoomsPerRequest: 4 };
const RETENTION_POLICY = { reservationPiiRetentionDays: 1 };
const containers: StartedPostgreSqlContainer[] = [];
let runtime: Runtime;
let keyring: Keyring;
let reservationAccess: BookingReservationAccess;
let failAfterRoomNightRelease = false;
const paymentInitiations: PaymentInitiationInput[] = [];
const defaultPaymentResult = (input: PaymentInitiationInput): PaymentInitiationResult => ({
  status: 'redirect',
  providerRef: `booking-test:${input.reference}`,
  action: { type: 'redirect', url: 'https://payments.example.test/continue' },
});
let paymentResult = defaultPaymentResult;
let paymentMethods: readonly PaymentMethod[] = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];
let paymentSetupError: Error | undefined;
let bookingPaymentProviderId = 'booking-test-payment';
const refundInvocations: PaymentRefundInputV2[] = [];
let refundResult: PaymentRefundResult = { status: 'succeeded', providerRefundRef: 'booking-test-refund' };
let refundError: Error | undefined;

const bookingPaymentProvider: PaymentProviderV2 = {
  get id() { return bookingPaymentProviderId; },
  kind: 'payment',
  paymentMethods: () => {
    if (paymentSetupError) throw paymentSetupError;
    return paymentMethods;
  },
  initiate: async (input): Promise<PaymentInitiationResult> => {
    paymentInitiations.push(input);
    return paymentResult(input);
  },
  refund: async input => {
    refundInvocations.push(input);
    if (refundError) throw refundError;
    return refundResult;
  },
  parseCallback: async () => {
    throw new Error('callback mapping belongs to SW-128');
  },
  acknowledgeCallback: () => ({ body: 'ok' }),
};

const testRoomNightOperations: BookingAvailabilityRoomNightOperations = {
  reserve: (tx, input, now) => bookingAvailabilityRoomNightOperations.reserve(tx, input, now),
  release: async (tx, input, now) => {
    const result = await bookingAvailabilityRoomNightOperations.release(tx, input, now);
    if (failAfterRoomNightRelease) throw new Error('forced post-release failure');
    return result;
  },
};

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + days);
  date.setUTCHours(0, 0, 0, 0);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function propertyLocalDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: PROPERTY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

beforeAll(async () => {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_reservation')
    .withUsername('booking')
    .withPassword('booking')
    .start();
  containers.push(container);
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-reservation-test', name: 'Booking Reservation Test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = {
    get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? TEST_SECRET : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
    listNames: () => ['SW_SIGNING_KEY_TEST'],
  };
  keyring = resolveKeyring(config, secrets)!;
  reservationAccess = createBookingReservationAccess(keyring);
  const quoteReservationBinding = bindBookingAvailabilityQuoteReservation(propertyBinding, QUOTE_LIMITS, keyring);
  const roomNightOperationsBinding = bindModuleCapability(
    'booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, testRoomNightOperations,
  );
  runtime = await createRuntime({
    release: { id: 'booking-reservation-test', version: '1.0.0', buildManifestChecksum: `sha256:${'8'.repeat(64)}` },
    roles: BASE_ROLES, config, secrets,
    logger: noopLogger, availableExtensions: {},
    modules: [
      createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, keyring),
      createBookingPropertyModule(),
      createBookingReservationModule(
        quoteReservationBinding, roomNightOperationsBinding, reservationAccess, RETENTION_POLICY, bookingPaymentProvider,
        'booking-alerts@example.test',
      ),
    ],
  });
  await runtime.migrate();
  await runtime.commands.execute('booking.property.create', {
    name: '海角旅店', address: {
      countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles',
      addressLine1: 'Ocean Avenue 1', addressLine2: null,
    }, timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([
    ...(runtime ? [runtime.close()] : []),
    ...containers.splice(0).map(container => container.stop()),
  ]);
});

async function createFixture(code: string, sellableUnits = 3, baseNightlyPriceMinor = 12_345) {
  const roomType = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
    code, name: `房型 ${code}`, description: null, maxOccupancyPerUnit: 4,
    beds: [{ type: 'queen' as const, count: 1 }], amenities: [], minimumStayNights: 1,
    maximumStayNights: null, mediaAssetId: null,
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
    roomTypeId: roomType.id, baseNightlyPriceMinor,
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  const checkInLocalDate = addDays(propertyLocalDate(new Date()), 7);
  const checkOutLocalDate = addDays(checkInLocalDate, 2);
  const quoteRequest = { roomTypeId: roomType.id, checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 };
  await runtime.commands.execute('booking.availability.updateRoomNightRange', {
    roomTypeId: roomType.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate,
    sellableUnits,
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  const quoteResult = await runtime.queries.execute<{ kind: 'available'; quote: BookingQuote } | { kind: 'unavailable' }>(
    'booking.availability.getQuote', quoteRequest, { actor: RESERVATION_ACTOR },
  );
  if (quoteResult.kind !== 'available') throw new Error('Test fixture did not produce an available Quote');
  return { roomType, quote: quoteResult.quote };
}

function inputFor(quote: BookingQuote) {
  return {
    quote: {
      roomTypeId: quote.roomTypeId,
      checkInLocalDate: quote.checkInLocalDate,
      checkOutLocalDate: quote.checkOutLocalDate,
      adults: quote.adults,
      children: quote.children,
      roomCount: quote.roomCount,
      fingerprint: quote.fingerprint,
    },
    booker: { name: 'Private Booker Name', email: 'private.booker@example.test', phone: '+1 555 0100' },
    primaryGuestName: 'Private Guest Name',
    accommodationNotes: 'Private arrival note',
  };
}

async function reservedCounts(roomTypeId: string): Promise<number[]> {
  const result = await runtime.database.pool.query<{ reserved_units: number }>(
    'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date', [roomTypeId],
  );
  return result.rows.map(row => row.reserved_units);
}

async function reservationCount(roomTypeId: string): Promise<number> {
  const result = await runtime.database.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM booking_reservation_reservations WHERE room_type_id = $1', [roomTypeId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function paymentAttemptsFor(reservationId: string) {
  const result = await runtime.database.pool.query<{
    id: string; reference: string; status: string; provider_ref: string | null; expires_at: Date;
  }>(`
    SELECT id, reference, status, provider_ref, expires_at
    FROM booking_reservation_payment_attempts
    WHERE reservation_id = $1
    ORDER BY created_at, id
  `, [reservationId]);
  return result.rows;
}

async function clearPaymentAttemptJobs(reservationId: string) {
  await runtime.database.pool.query(`
    DELETE FROM platform_jobs
    WHERE type = 'booking.reservation.process-payment' AND payload->>'reservationId' = $1
  `, [reservationId]);
}

async function clearRefundJobs(reservationId: string) {
  await runtime.database.pool.query(`
    DELETE FROM platform_jobs
    WHERE type = 'booking.reservation.process-refund'
      AND payload->>'refundId' IN (SELECT id::text FROM booking_reservation_refunds WHERE reservation_id = $1)
  `, [reservationId]);
}

async function createCancellationRefund(input: { reservationId: string; paymentAttemptId: string; amountMinor: number }) {
  return runtime.database.transaction(async tx => {
    const context: CommandContext = {
      actor: SYSTEM_ACTOR,
      tx,
      logger: noopLogger,
      correlationId: `booking-reservation-cancellation-refund:${randomUUID()}`,
      now: new Date(),
      publish: async () => {},
      audit: async () => {},
      enqueue: async job => { await runtime.jobs.enqueue(tx, job); },
    };
    return createRequiredBookingReservationRefund(context, {
      ...input,
      reason: 'reservation_cancellation',
      allowExisting: false,
    });
  });
}

async function createReservation(code: string) {
  const { roomType, quote } = await createFixture(code);
  const result = await runtime.commands.execute<{
    kind: 'created' | 'stale' | 'unavailable';
    reservation?: { id: string; paymentExpiresAt: string };
  }>('booking.reservation.create', inputFor(quote), {
    actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
  });
  if (result.kind !== 'created' || !result.reservation) throw new Error(`Could not create Reservation fixture ${code}`);
  return { roomType, reservation: result.reservation };
}

async function expireReservation(reservationId: string, expectedPaymentExpiresAt: string, idempotencyKey = randomUUID()) {
  return runtime.commands.execute<{ kind: 'expired' | 'noop' }>('booking.reservation.expire', {
    reservationId, expectedPaymentExpiresAt,
  }, { actor: SYSTEM_ACTOR, idempotencyKey });
}

async function holdReservationLifecycleLock(reservationId: string): Promise<() => Promise<void>> {
  const client = await runtime.database.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM booking_reservation_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  return async () => {
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
}

async function waitForDatabaseLockWait(expected = 1): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await runtime.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    if (Number(waiting.rows[0]?.count) >= expected) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a competing Reservation transaction to wait on a PostgreSQL lock');
}

async function waitForReservationLockBlocking(holderPid: number, expected: number): Promise<void> {
  // pg_blocking_pids(pid) only reports the immediate blocker, so a session queued behind
  // another waiter (e.g. blocked on a tuple lock held by a session itself waiting on the
  // holder's transaction) does not list the holder directly; walk the chain transitively.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await runtime.database.pool.query<{ pid: number; blocking: number[] }>(`
      SELECT pid, pg_catalog.pg_blocking_pids(pid) AS blocking
      FROM pg_catalog.pg_stat_activity WHERE datname = current_database()
    `);
    const blockingByPid = new Map(activity.rows.map(row => [row.pid, row.blocking]));
    const blockedByHolder = activity.rows.filter(row => {
      const seen = new Set<number>();
      let frontier = row.blocking;
      while (frontier.length > 0) {
        if (frontier.includes(holderPid)) return true;
        const next: number[] = [];
        for (const pid of frontier) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          next.push(...(blockingByPid.get(pid) ?? []));
        }
        frontier = next;
      }
      return false;
    });
    if (blockedByHolder.length >= expected) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expected} transaction(s) blocked on the Reservation lock holder`);
}

async function raceUnderReservationLock<A, B>(
  reservationId: string, first: () => Promise<A>, second: () => Promise<B>,
): Promise<[Promise<A>, Promise<B>]> {
  const client = await runtime.database.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM booking_reservation_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  const holderPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  try {
    const firstPromise = first();
    await waitForReservationLockBlocking(holderPid, 1);
    const secondPromise = second();
    await waitForReservationLockBlocking(holderPid, 2);
    return [firstPromise, secondPromise];
  } finally {
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
}

async function recordVerifiedPaymentOutcome(provider: string, event: Record<string, unknown>, idempotencyKey = randomUUID()) {
  return runtime.commands.execute<{ attempt: { id: string; status: string } }>(
    'booking.reservation.recordVerifiedPaymentOutcome', { provider, event },
    { actor: SYSTEM_ACTOR, idempotencyKey },
  );
}

async function confirmReservationForCancellation(reservationId: string) {
  const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
    'booking.reservation.startPayment', { reservationId, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservationId) },
    { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
  );
  await clearPaymentAttemptJobs(reservationId);
  await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
    type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `callback:cancel:${started.attempt.id}`,
  });
  return started.attempt;
}

async function managementCredentialFor(reservationId: string) {
  const issued = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, { reservationId, ttlMs: 15 * 60_000 }));
  return (await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: issued.grantToken }))).managementCredential;
}

async function checkoutCredentialFor(reservationId: string) {
  return (await runtime.database.transaction(tx => reservationAccess.checkout.present(tx, reservationId))).credential;
}

async function drainBookingNotificationWork() {
  const worker = new Worker(runtime, { workerId: `booking-notification-${randomUUID().slice(0, 8)}`, concurrency: 1 });
  let relayed = 0;
  let processed = 0;
  let failed = 0;
  // This file deliberately shares one Testcontainers database so it can cover
  // cross-command durability.  Earlier lifecycle fixtures legitimately leave
  // their notification deliveries pending; drain that bounded backlog before
  // asserting the notifications created by the current fixture.
  for (let round = 0; round < 100; round += 1) {
    const relay = await worker.relayOutbox();
    const jobs = await worker.runJobs();
    relayed += relay.relayed;
    processed += jobs.processed;
    failed += jobs.failed;
    if (relay.relayed === 0 && jobs.processed === 0 && jobs.failed === 0) break;
  }
  return { relayed, processed, failed };
}

async function createAlertRepairRuntime(operatorAlertEmail?: string): Promise<Runtime> {
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-reservation-test', name: 'Booking Reservation Test' },
    database: { url: containers[0]!.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = {
    get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? TEST_SECRET : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
    listNames: () => ['SW_SIGNING_KEY_TEST'],
  };
  const property = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const quote = bindBookingAvailabilityQuoteReservation(property, QUOTE_LIMITS, keyring);
  const nights = bindModuleCapability('booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
    testRoomNightOperations);
  const created = await createRuntime({
    release: { id: 'booking-reservation-test', version: '1.0.0', buildManifestChecksum: `sha256:${'8'.repeat(64)}` },
    roles: BASE_ROLES, config, secrets, logger: noopLogger, availableExtensions: {},
    modules: [
      createBookingAvailabilityModule(property, QUOTE_LIMITS, keyring),
      createBookingPropertyModule(),
      createBookingReservationModule(quote, nights, createBookingReservationAccess(keyring), RETENTION_POLICY,
        bookingPaymentProvider, operatorAlertEmail),
    ],
  });
  await created.migrate();
  return created;
}

async function enqueueRetentionJob(dedupeKey: string) {
  const clock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
  await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
    type: 'booking.reservation.anonymize-expired-pii',
    payload: { bucket: Math.floor(clock.rows[0]!.now.getTime() / 86_400_000), scheduledFor: clock.rows[0]!.now.toISOString() },
    dedupeKey,
    runAt: new Date(clock.rows[0]!.now.getTime() - 1_000),
  }));
  return new Worker(runtime, { workerId: `booking-retention-${randomUUID().slice(0, 8)}`, concurrency: 1 });
}

async function enqueueAndRunRetentionJob(dedupeKey: string) {
  return drainRetentionJobs(await enqueueRetentionJob(dedupeKey));
}

async function drainRetentionJobs(worker: Worker) {
  let processed = 0;
  let failed = 0;
  for (let round = 0; round < 1_000; round += 1) {
    const result = await worker.runJobs();
    processed += result.processed;
    failed += result.failed;
    if (result.failed > 0 || result.processed === 0) return { processed, failed };
  }
  throw new Error('Reservation retention continuation did not drain within 1,000 bounded jobs');
}

async function makeRetentionEligible(reservationId: string) {
  const databaseNow = await runtime.database.pool.query<{ now: Date }>('SELECT now() AS now');
  const checkout = addDays(propertyLocalDate(databaseNow.rows[0]!.now), -2);
  await runtime.database.pool.query(`
    UPDATE booking_reservation_reservations
    SET status = 'confirmed', check_in_local_date = $2, check_out_local_date = $3
    WHERE id = $1
  `, [reservationId, addDays(checkout, -2), checkout]);
}

async function cloneReservations(templateId: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await runtime.database.pool.query(`
    INSERT INTO booking_reservation_reservations (
      id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
      booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes,
      status, payment_expires_at, currency, total_minor, nightly_prices, cancellation_policy,
      quote_fingerprint, created_at, access_generation, access_grant_nonce, access_grant_expires_at,
      access_grant_used_at, management_token_hash, owner_account_id, pii_anonymized_at
    )
    SELECT clone.id, source.room_type_id, source.check_in_local_date, source.check_out_local_date,
      source.room_count, source.adults, source.children, source.booker_name, source.booker_email,
      source.booker_phone, source.primary_guest_name, source.accommodation_notes, 'confirmed',
      source.payment_expires_at, source.currency, source.total_minor, source.nightly_prices,
      source.cancellation_policy, source.quote_fingerprint, source.created_at, 0, NULL, NULL, NULL,
      NULL, NULL, NULL
    FROM unnest($2::uuid[]) AS clone(id)
    CROSS JOIN booking_reservation_reservations AS source
    WHERE source.id = $1
  `, [templateId, ids]);
  return ids;
}

describe('Booking Reservation PostgreSQL integration', () => {
  it('starts one deferred payment attempt through the neutral Provider ABI', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    const { reservation } = await createReservation('payment-attempt-main');
    const idempotencyKey = randomUUID();

    const started = await runtime.commands.execute<{
      attempt: { id: string; reference: string; status: string; provider: string; method: string; expiresAt: string };
    }>('booking.reservation.startPayment', {
      reservationId: reservation.id,
      method: 'deferred',
      checkoutCredential: await checkoutCredentialFor(reservation.id),
    }, { actor: RESERVATION_ACTOR, idempotencyKey });

    expect(started.attempt).toMatchObject({
      id: expect.any(String), reference: expect.any(String), status: 'created',
      provider: bookingPaymentProviderId, method: 'deferred', expiresAt: reservation.paymentExpiresAt,
    });
    expect(paymentInitiations).toEqual([]);

    const beforeWorker = await runtime.database.pool.query<{
      reference: string; status: string; provider: string; method: string; amount_minor: number; currency: string;
    }>(`
      SELECT reference, status, provider, method, amount_minor::float8 AS amount_minor, currency
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(beforeWorker.rows).toEqual([{
      reference: started.attempt.reference, status: 'created', provider: bookingPaymentProviderId, method: 'deferred',
      amount_minor: 24_690, currency: 'USD',
    }]);

    const worker = new Worker(runtime, { workerId: `booking-payment-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(paymentInitiations).toHaveLength(1);
    expect(paymentInitiations[0]).toMatchObject({
      reference: started.attempt.reference, amount: 24_690, currency: 'USD', method: 'deferred',
    });
    expect(Object.keys(paymentInitiations[0]!).sort()).toEqual([
      'amount', 'currency', 'displayReference', 'method', 'reference',
    ]);
    expect(paymentInitiations[0]?.displayReference).toEqual(expect.any(String));

    const afterWorker = await runtime.database.pool.query<{ status: string; provider_ref: string }>(`
      SELECT status, provider_ref FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(afterWorker.rows).toEqual([{
      status: 'submitted', provider_ref: `booking-test:${started.attempt.reference}`,
    }]);

    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(runtime.commands.execute('booking.reservation.startPayment', {
      reservationId: reservation.id,
      method: 'deferred',
      checkoutCredential: await checkoutCredentialFor(reservation.id),
    }, { actor: RESERVATION_ACTOR, idempotencyKey })).resolves.toEqual(started);
    expect(paymentInitiations).toHaveLength(1);
  }, 120_000);

  it('permits a fresh Attempt only after a definite failure or an expired Attempt', async () => {
    paymentInitiations.length = 0;
    paymentResult = (input) => ({
      status: 'failed', reason: 'provider_rejected', providerRef: `booking-test:${input.reference}`,
      message: 'declined by test provider',
    });
    const { reservation } = await createReservation('payment-attempt-retry');

    const failed = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    const worker = new Worker(runtime, { workerId: `booking-payment-failed-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(await paymentAttemptsFor(reservation.id)).toMatchObject([{
      id: failed.attempt.id, reference: failed.attempt.reference, status: 'failed',
      provider_ref: `booking-test:${failed.attempt.reference}`,
    }]);

    paymentResult = defaultPaymentResult;
    const retry = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    expect(retry.attempt.reference).not.toBe(failed.attempt.reference);

    await runtime.database.pool.query(`
      UPDATE booking_reservation_payment_attempts
      SET expires_at = pg_catalog.clock_timestamp() - interval '1 second'
      WHERE id = $1
    `, [retry.attempt.id]);
    const retryAfterExpiry = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    expect(retryAfterExpiry.attempt.reference).not.toBe(retry.attempt.reference);
    expect(await paymentAttemptsFor(reservation.id)).toMatchObject([
      { id: failed.attempt.id, status: 'failed' },
      { id: retry.attempt.id, status: 'expired' },
      { id: retryAfterExpiry.attempt.id, status: 'created' },
    ]);
    await clearPaymentAttemptJobs(reservation.id);
  }, 120_000);

  it('records deferred payment instructions without extending the Reservation payment window', async () => {
    paymentInitiations.length = 0;
    const { reservation } = await createReservation('payment-attempt-awaiting');
    const reservationDeadline = new Date(reservation.paymentExpiresAt);
    const providerDeadline = new Date(reservationDeadline.getTime() - 60_000);
    paymentResult = (input) => ({
      status: 'awaiting_payment', providerRef: `booking-test:${input.reference}`,
      instructions: [{ label: 'Bank code', value: '123456' }], expiresAt: providerDeadline.toISOString(),
    });
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    const worker = new Worker(runtime, { workerId: `booking-payment-awaiting-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    const stored = await runtime.database.pool.query<{
      status: string; provider_ref: string; instructions: unknown; expires_at: Date;
    }>(`
      SELECT status, provider_ref, instructions, expires_at
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(stored.rows).toEqual([{
      status: 'awaiting_payment', provider_ref: expect.stringContaining('booking-test:'),
      instructions: [{ label: 'Bank code', value: '123456' }], expires_at: providerDeadline,
    }]);

    const { reservation: laterReservation } = await createReservation('payment-attempt-awaiting-later-deadline');
    const laterReservationDeadline = new Date(laterReservation.paymentExpiresAt);
    paymentResult = (input) => ({
      status: 'awaiting_payment', providerRef: `booking-test:${input.reference}`,
      instructions: [{ label: 'Bank code', value: '123456' }],
      expiresAt: new Date(laterReservationDeadline.getTime() + 60_000).toISOString(),
    });
    const laterStarted = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: laterReservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(laterReservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    const laterStored = await runtime.database.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM booking_reservation_payment_attempts WHERE id = $1', [laterStarted.attempt.id],
    );
    expect(laterStored.rows).toEqual([{ expires_at: laterReservationDeadline }]);
    const laterReservationStored = await runtime.database.pool.query<{ payment_expires_at: Date }>(
      'SELECT payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [laterReservation.id],
    );
    expect(laterReservationStored.rows).toEqual([{ payment_expires_at: laterReservationDeadline }]);
    const expiryJobBeforeReplay = await runtime.database.pool.query<{ payload: unknown; run_at: Date }>(
      'SELECT payload, run_at FROM platform_jobs WHERE dedupe_key = $1', [`booking-reservation:expire:${laterReservation.id}`],
    );
    await runtime.commands.execute('booking.reservation.recordPaymentResult', {
      attemptId: laterStarted.attempt.id, provider: bookingPaymentProviderId,
      result: {
        status: 'awaiting_payment', providerRef: `booking-test:${laterStarted.attempt.reference}`,
        instructions: [{ label: 'Bank code', value: '123456' }],
        expiresAt: new Date(laterReservationDeadline.getTime() + 60_000).toISOString(),
      },
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    const [attemptAfterReplay, reservationAfterReplay, expiryJobAfterReplay] = await Promise.all([
      runtime.database.pool.query<{ expires_at: Date; updated_at: Date }>(
        'SELECT expires_at, updated_at FROM booking_reservation_payment_attempts WHERE id = $1', [laterStarted.attempt.id],
      ),
      runtime.database.pool.query<{ payment_expires_at: Date }>(
        'SELECT payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [laterReservation.id],
      ),
      runtime.database.pool.query<{ payload: unknown; run_at: Date }>(
        'SELECT payload, run_at FROM platform_jobs WHERE dedupe_key = $1', [`booking-reservation:expire:${laterReservation.id}`],
      ),
    ]);
    expect(attemptAfterReplay.rows[0]?.expires_at).toEqual(laterReservationDeadline);
    expect(reservationAfterReplay.rows).toEqual([{ payment_expires_at: laterReservationDeadline }]);
    expect(expiryJobAfterReplay.rows).toEqual(expiryJobBeforeReplay.rows);
    await clearPaymentAttemptJobs(reservation.id);
    await clearPaymentAttemptJobs(laterReservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('confirms an immediate payment through the shared winner path', async () => {
    paymentInitiations.length = 0;
    paymentResult = input => ({ status: 'confirmed', providerRef: `booking-test:${input.reference}` });
    paymentMethods = [{ code: 'immediate', label: 'Immediate test payment', timing: 'immediate' }];
    const { roomType, reservation } = await createReservation('payment-attempt-synchronous-confirmation');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'immediate', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    const worker = new Worker(runtime, { workerId: `booking-payment-confirmed-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });

    const attempt = await runtime.database.pool.query<{ status: string; provider_ref: string; success_kind: string; succeeded_at: Date }>(`
      SELECT status, provider_ref, success_kind, succeeded_at
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(attempt.rows).toEqual([{
      status: 'succeeded', provider_ref: `booking-test:${started.attempt.reference}`,
      success_kind: 'winning', succeeded_at: expect.any(Date),
    }]);
    const job = await runtime.database.pool.query<{ status: string }>(`
      SELECT status FROM platform_jobs
      WHERE type = 'booking.reservation.process-payment' AND payload->>'attemptId' = $1
    `, [started.attempt.id]);
    expect(job.rows).toEqual([{ status: 'completed' }]);
    const storedReservation = await runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string }>(
      'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(storedReservation.rows).toEqual([{ status: 'confirmed', winning_payment_attempt_id: started.attempt.id }]);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    await clearPaymentAttemptJobs(reservation.id);
    paymentResult = defaultPaymentResult;
    paymentMethods = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];
  }, 120_000);

  it('lets a verified deadline extension beat the queued original expiry command', async () => {
    const { roomType, reservation } = await createReservation('expiry-extension-race');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    const clock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const originalDeadline = new Date(clock.rows[0]!.now.getTime() - 1_000).toISOString();
    const extendedDeadline = new Date(clock.rows[0]!.now.getTime() + 60_000).toISOString();
    const dedupeKey = `booking-reservation:expire:${reservation.id}`;
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, originalDeadline],
    );
    await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
      type: 'booking.reservation.expire',
      payload: { reservationId: reservation.id, expectedPaymentExpiresAt: originalDeadline },
      dedupeKey, runAt: new Date(originalDeadline), replaceExisting: true,
    }));
    const originalJob = await runtime.database.pool.query<{ id: string; payload: unknown; run_at: Date }>(
      'SELECT id, payload, run_at FROM platform_jobs WHERE dedupe_key = $1', [dedupeKey],
    );
    expect(originalJob.rows).toMatchObject([{
      payload: { reservationId: reservation.id, expectedPaymentExpiresAt: originalDeadline },
      run_at: new Date(originalDeadline),
    }]);

    const unlock = await holdReservationLifecycleLock(reservation.id);
    let extension: ReturnType<typeof recordVerifiedPaymentOutcome> | undefined;
    let expiry: ReturnType<typeof expireReservation> | undefined;
    try {
      extension = recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_info_issued', reference: started.attempt.reference,
        providerRef: `callback:extension:${started.attempt.id}`,
        instructions: [{ label: 'Account', value: 'extended' }], expiresAt: extendedDeadline,
      });
      await waitForDatabaseLockWait();
      expiry = expireReservation(reservation.id, originalDeadline);
      await waitForDatabaseLockWait(2);
    } finally {
      await unlock();
    }
    await expect(extension).resolves.toMatchObject({ attempt: { id: started.attempt.id, status: 'awaiting_payment' } });
    await expect(expiry).resolves.toEqual({ kind: 'noop' });
    const [state, attempts, replacementJob, expiryAudit] = await Promise.all([
      runtime.database.pool.query<{ status: string; payment_expires_at: Date }>(
        'SELECT status, payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [reservation.id]),
      paymentAttemptsFor(reservation.id),
      runtime.database.pool.query<{ id: string; status: string; payload: unknown; run_at: Date }>(
        'SELECT id, status, payload, run_at FROM platform_jobs WHERE dedupe_key = $1', [dedupeKey]),
      runtime.database.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM platform_audit_log
        WHERE action = 'booking.reservation.expired' AND resource_id = $1`, [reservation.id]),
    ]);
    expect(state.rows).toEqual([{ status: 'pending_payment', payment_expires_at: new Date(extendedDeadline) }]);
    expect(attempts).toMatchObject([{ id: started.attempt.id, status: 'awaiting_payment', expires_at: new Date(extendedDeadline) }]);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    expect(replacementJob.rows).toEqual([{
      id: originalJob.rows[0]!.id, status: 'pending',
      payload: { reservationId: reservation.id, expectedPaymentExpiresAt: extendedDeadline },
      run_at: new Date(extendedDeadline),
    }]);
    expect(expiryAudit.rows).toEqual([{ count: '0' }]);
  }, 120_000);

  it('maps verified callback outcomes by neutral reference with replay, extension, and excess evidence', async () => {
    const { reservation } = await createReservation('verified-payment-outcome');
    const first = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    const firstDeadline = new Date(new Date(reservation.paymentExpiresAt).getTime() + 30_000).toISOString();
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: first.attempt.reference, providerRef: 'callback:first',
      instructions: [{ label: 'Account', value: '123' }], expiresAt: firstDeadline,
    })).resolves.toMatchObject({ attempt: { id: first.attempt.id, status: 'awaiting_payment' } });
    const firstCallbackDeadline = await runtime.database.pool.query<{ attempt_expires_at: Date; payment_expires_at: Date }>(`
      SELECT a.expires_at AS attempt_expires_at, r.payment_expires_at
      FROM booking_reservation_payment_attempts a
      JOIN booking_reservation_reservations r ON r.id = a.reservation_id
      WHERE a.id = $1
    `, [first.attempt.id]);
    expect(firstCallbackDeadline.rows).toEqual([{
      attempt_expires_at: new Date(firstDeadline), payment_expires_at: new Date(firstDeadline),
    }]);
    const firstCallbackEvidence = await runtime.database.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM booking_reservation_payment_attempts WHERE id = $1', [first.attempt.id],
    );
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: first.attempt.reference, providerRef: 'callback:first',
      instructions: [{ label: 'Account', value: '123' }], expiresAt: firstDeadline,
    })).resolves.toMatchObject({ attempt: { id: first.attempt.id, status: 'awaiting_payment' } });
    const exactReplayEvidence = await runtime.database.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM booking_reservation_payment_attempts WHERE id = $1', [first.attempt.id],
    );
    expect(exactReplayEvidence.rows).toEqual(firstCallbackEvidence.rows);
    const extendedDeadline = new Date(new Date(reservation.paymentExpiresAt).getTime() + 60_000).toISOString();
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: first.attempt.reference, providerRef: 'callback:first',
      instructions: [{ label: 'Account', value: '123' }], expiresAt: extendedDeadline,
    })).resolves.toMatchObject({ attempt: { id: first.attempt.id, status: 'awaiting_payment' } });
    const extension = await runtime.database.pool.query<{ payment_expires_at: Date }>(
      'SELECT payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(extension.rows[0]?.payment_expires_at.toISOString()).toBe(extendedDeadline);
    const staleAttemptBefore = await runtime.database.pool.query<{ expires_at: Date; updated_at: Date }>(
      'SELECT expires_at, updated_at FROM booking_reservation_payment_attempts WHERE id = $1', [first.attempt.id],
    );
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: first.attempt.reference, providerRef: 'callback:stale',
      instructions: [{ label: 'Account', value: 'obsolete' }], expiresAt: firstDeadline,
    })).resolves.toMatchObject({ attempt: { id: first.attempt.id, status: 'awaiting_payment' } });
    const [staleAttemptAfter, staleReservationAfter] = await Promise.all([
      runtime.database.pool.query<{ expires_at: Date; updated_at: Date }>(
        'SELECT expires_at, updated_at FROM booking_reservation_payment_attempts WHERE id = $1', [first.attempt.id],
      ),
      runtime.database.pool.query<{ payment_expires_at: Date }>(
        'SELECT payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
      ),
    ]);
    expect(staleAttemptAfter.rows).toEqual(staleAttemptBefore.rows);
    expect(staleReservationAfter.rows).toEqual(extension.rows);

    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_failed', reference: first.attempt.reference, providerRef: 'callback:first', message: 'declined',
    });
    const failedBeforeRetry = await runtime.database.pool.query<{
      attempt_status: string; reservation_status: string; winning_payment_attempt_id: string | null;
    }>(`
      SELECT a.status AS attempt_status, r.status AS reservation_status, r.winning_payment_attempt_id
      FROM booking_reservation_payment_attempts a
      JOIN booking_reservation_reservations r ON r.id = a.reservation_id
      WHERE a.id = $1
    `, [first.attempt.id]);
    expect(failedBeforeRetry.rows).toEqual([{
      attempt_status: 'failed', reservation_status: 'pending_payment', winning_payment_attempt_id: null,
    }]);
    const second = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: second.attempt.reference, providerRef: 'callback:second',
    });
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: second.attempt.reference, providerRef: 'callback:second',
    })).resolves.toMatchObject({ attempt: { id: second.attempt.id, status: 'succeeded' } });
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: second.attempt.reference, providerRef: 'callback:other',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const winningReservation = await runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string }>(
      'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(winningReservation.rows).toEqual([{
      status: 'confirmed', winning_payment_attempt_id: second.attempt.id,
    }]);
    const firstDeliveryKey = randomUUID();
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: 'callback:late-first',
    }, firstDeliveryKey);
    const outcomes = await runtime.database.pool.query<{ id: string; status: string; success_kind: string | null }>(
      'SELECT id, status, success_kind FROM booking_reservation_payment_attempts WHERE reservation_id = $1 ORDER BY created_at, id', [reservation.id],
    );
    expect(outcomes.rows).toEqual([
      { id: first.attempt.id, status: 'succeeded', success_kind: 'excess' },
      { id: second.attempt.id, status: 'succeeded', success_kind: 'winning' },
    ]);
    const refunds = await runtime.database.pool.query<{
      payment_attempt_id: string; reason: string; amount_minor: string; currency: string; status: string; provider_request_ref: string;
    }>('SELECT payment_attempt_id, reason, amount_minor::text, currency, status, provider_request_ref FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
    expect(refunds.rows).toEqual([{
      payment_attempt_id: first.attempt.id, reason: 'excess_payment', amount_minor: '24690', currency: 'USD', status: 'pending',
      provider_request_ref: expect.stringMatching(/^booking-refund:/),
    }]);
    const refund = refunds.rows[0]!;
    const processing = await runtime.queries.execute<any>('booking.reservation.getRefundForProcessing', {
      refundId: (await runtime.database.pool.query<{ id: string }>('SELECT id FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [first.attempt.id])).rows[0]!.id,
      generation: 1,
    }, { actor: SYSTEM_ACTOR });
    expect(processing).toMatchObject({ kind: 'invoke', request: {
      providerRef: 'callback:late-first', amount: 24690, currency: 'USD', reference: refund.provider_request_ref,
    } });
    const replayDeliveryKey = randomUUID();
    expect(replayDeliveryKey).not.toBe(firstDeliveryKey);
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: 'callback:late-first',
    }, replayDeliveryKey)).resolves.toMatchObject({ attempt: { id: first.attempt.id, status: 'succeeded' } });
    const replayedRefunds = await runtime.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [first.attempt.id],
    );
    expect(replayedRefunds.rows).toEqual([{ count: '1' }]);
    await clearRefundJobs(reservation.id);
  }, 120_000);

  it('rejects untrusted callback callers, provider mismatches, and unknown references', async () => {
    const { reservation } = await createReservation('verified-payment-invalid');
    const started = await runtime.commands.execute<{ attempt: { reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    const event = { type: 'payment_confirmed', reference: started.attempt.reference, providerRef: 'callback:valid' };
    await expect(runtime.commands.execute('booking.reservation.recordVerifiedPaymentOutcome', {
      provider: bookingPaymentProviderId, event,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(recordVerifiedPaymentOutcome('other-provider', event)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      ...event, reference: 'booking-payment:unknown',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.commands.execute('booking.reservation.recordVerifiedPaymentOutcome', {
      provider: bookingPaymentProviderId,
      event: { type: 'payment_confirmed', reference: started.attempt.reference },
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, 120_000);

  it('executes an excess refund through the neutral Provider with a stable request reference and immutable invocation evidence', async () => {
    refundInvocations.length = 0;
    refundResult = { status: 'succeeded', providerRefundRef: 'booking-test-refund:stable' };
    refundError = new Error('secret transport detail must not persist');
    const { reservation } = await createReservation('refund-provider-success');
    await clearRefundJobs(reservation.id);
    const first = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_failed', reference: first.attempt.reference, providerRef: 'refund:first', message: 'retry fixture',
    });
    const winner = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: winner.attempt.reference, providerRef: 'refund:winner',
    });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: 'refund:excess',
    });
    await runtime.database.pool.query(`UPDATE platform_jobs SET attempts = 4 WHERE type = 'booking.reservation.process-refund'
      AND payload->>'refundId' IN (SELECT id::text FROM booking_reservation_refunds WHERE payment_attempt_id = $1)`, [first.attempt.id]);
    const worker = new Worker(runtime, { workerId: `booking-refund-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ failed: 1 });
    const failed = await runtime.database.pool.query<{ id: string; status: string; failure_kind: string; failure_message: string }>(
      'SELECT id, status, failure_kind, failure_message FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [first.attempt.id],
    );
    expect(failed.rows[0]).toMatchObject({ status: 'failed', failure_kind: 'indeterminate', failure_message: 'Provider refund transport failed' });
    refundError = undefined;
    await runtime.commands.execute('booking.reservation.retryRefund', { refundId: failed.rows[0]!.id }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    for (let round = 0; round < 10 && refundInvocations.length < 2; round += 1) await worker.runJobs();
    expect(refundInvocations).toHaveLength(2);
    expect(refundInvocations[1]!.reference).toBe(refundInvocations[0]!.reference);
    expect(refundInvocations[1]).toMatchObject({ providerRef: 'refund:excess', amount: 24690, currency: 'USD', reference: expect.stringMatching(/^booking-refund:/) });
    const evidence = await runtime.database.pool.query<{
      status: string; generation: number; provider_request_ref: string; provider_refund_ref: string | null;
      outcome: string; worker_attempt: number;
    }>(`
      SELECT r.status, r.generation, r.provider_request_ref, r.provider_refund_ref, i.outcome, i.worker_attempt
      FROM booking_reservation_refunds r
      JOIN booking_reservation_refund_invocations i ON i.refund_id = r.id
      WHERE r.payment_attempt_id = $1
    `, [first.attempt.id]);
    expect(evidence.rows).toEqual(expect.arrayContaining([{
      status: 'succeeded', generation: 2, provider_request_ref: refundInvocations[1]!.reference,
      provider_refund_ref: 'booking-test-refund:stable', outcome: 'succeeded', worker_attempt: 1,
    }]));
    refundError = undefined;
    await expect(runtime.commands.execute('booking.reservation.requestRequiredPaymentRefund', {
      reservationId: reservation.id, paymentAttemptId: first.attempt.id, reason: 'excess_payment',
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    await clearRefundJobs(reservation.id);
  }, 120_000);

  it('persists a terminal indeterminate refund before dead-lettering a provider mismatch without invoking the adapter', async () => {
    refundInvocations.length = 0;
    const { reservation } = await createReservation('refund-provider-mismatch');
    const first = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_failed', reference: first.attempt.reference, providerRef: 'refund:mismatch-first', message: 'retry fixture',
    });
    const winner = await runtime.commands.execute<{ attempt: { reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: winner.attempt.reference, providerRef: 'refund:mismatch-winner',
    });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: 'refund:mismatch-excess',
    });

    bookingPaymentProviderId = 'booking-replaced-payment';
    try {
      const worker = new Worker(runtime, { workerId: `booking-refund-provider-mismatch-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      await expect(worker.runJobs()).resolves.toMatchObject({ processed: 0, failed: 1 });
      expect(refundInvocations).toEqual([]);
      const evidence = await runtime.database.pool.query<{
        refund_status: string; failure_kind: string; failure_message: string; outcome: string; reservation_status: string;
      }>(`
        SELECT r.status AS refund_status, r.failure_kind, r.failure_message, i.outcome, reservation.status AS reservation_status
        FROM booking_reservation_refunds r
        JOIN booking_reservation_refund_invocations i ON i.refund_id = r.id
        JOIN booking_reservation_reservations reservation ON reservation.id = r.reservation_id
        WHERE r.payment_attempt_id = $1
      `, [first.attempt.id]);
      expect(evidence.rows).toEqual([{
        refund_status: 'failed', failure_kind: 'indeterminate',
        failure_message: 'Configured refund provider does not match persisted refund evidence',
        outcome: 'indeterminate', reservation_status: 'confirmed',
      }]);
      const job = await runtime.database.pool.query<{ status: string }>(`
        SELECT status FROM platform_jobs
        WHERE type = 'booking.reservation.process-refund' AND payload->>'refundId' IN (
          SELECT id::text FROM booking_reservation_refunds WHERE payment_attempt_id = $1
        )
      `, [first.attempt.id]);
      expect(job.rows).toEqual([{ status: 'dead' }]);
    } finally {
      bookingPaymentProviderId = 'booking-test-payment';
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('keeps unsupported Provider results durable and leaves the Reservation confirmed', async () => {
    refundInvocations.length = 0;
    refundResult = { status: 'unsupported', message: 'Booking provider does not support refunds' };
    const { reservation } = await createReservation('refund-provider-unsupported');
    const first = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_failed', reference: first.attempt.reference, providerRef: 'refund:unsupported-first', message: 'retry fixture',
    });
    const winner = await runtime.commands.execute<{ attempt: { reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: winner.attempt.reference, providerRef: 'refund:unsupported-winner',
    });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: 'refund:unsupported-excess',
    });
    try {
      const worker = new Worker(runtime, { workerId: `booking-refund-unsupported-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(refundInvocations).toHaveLength(1);
      const result = await runtime.database.pool.query<{
        refund_status: string; failure_kind: string; failure_message: string; outcome: string; reservation_status: string;
      }>(`
        SELECT r.status AS refund_status, r.failure_kind, r.failure_message, i.outcome, reservation.status AS reservation_status
        FROM booking_reservation_refunds r
        JOIN booking_reservation_refund_invocations i ON i.refund_id = r.id
        JOIN booking_reservation_reservations reservation ON reservation.id = r.reservation_id
        WHERE r.payment_attempt_id = $1
      `, [first.attempt.id]);
      expect(result.rows).toEqual([{
        refund_status: 'failed', failure_kind: 'unsupported', failure_message: 'Booking provider does not support refunds',
        outcome: 'unsupported', reservation_status: 'confirmed',
      }]);
    } finally {
      refundResult = { status: 'succeeded', providerRefundRef: 'booking-test-refund' };
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('database-enforces that a refund and its payment Attempt belong to the same Reservation', async () => {
    const source = await createReservation('refund-attempt-reservation-source');
    const sourcePayment = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: source.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(source.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(source.reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: sourcePayment.attempt.reference, providerRef: 'refund:cross-reservation-source',
    });
    const other = await createReservation('refund-attempt-reservation-other');
    await expect(runtime.database.pool.query(`
      INSERT INTO booking_reservation_refunds (
        id, reservation_id, payment_attempt_id, reason, provider, payment_provider_ref,
        amount_minor, currency, provider_request_ref
      ) VALUES ($1, $2, $3, 'reservation_cancellation', 'booking-test-payment', 'refund:cross-reservation-source',
        24690, 'USD', $4)
    `, [randomUUID(), other.reservation.id, sourcePayment.attempt.id, `booking-refund:cross-reservation:${randomUUID()}`]))
      .rejects.toThrow(/booking_reservation_refund_attempt_reservation_fk/i);
  }, 120_000);

  it('reconciles past a dead oldest refund job without starving later pending refunds', async () => {
    const fixtures = Array.from({ length: 101 }, () => ({
      reservationId: randomUUID(), roomTypeId: randomUUID(), attemptId: randomUUID(), refundId: randomUUID(),
    }));
    const reservationIds = fixtures.map(fixture => fixture.reservationId);
    const roomTypeIds = fixtures.map(fixture => fixture.roomTypeId);
    const attemptIds = fixtures.map(fixture => fixture.attemptId);
    const refundIds = fixtures.map(fixture => fixture.refundId);
    await runtime.database.pool.query(`
      INSERT INTO booking_reservation_reservations (
        id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
        booker_name, booker_email, booker_phone, primary_guest_name, status, payment_expires_at,
        currency, total_minor, nightly_prices, cancellation_policy, quote_fingerprint
      )
      SELECT reservation_id, room_type_id, '2026-10-01', '2026-10-02', 1, 1, 0,
        'Reconcile Booker', 'reconcile@example.test', '000', 'Reconcile Guest', 'expired', clock_timestamp(),
        'USD', 24690, '[]'::jsonb, '{}'::jsonb, 'booking-quote-v1:reconcile:${'a'.repeat(64)}'
      FROM unnest($1::uuid[], $2::uuid[]) AS seed(reservation_id, room_type_id)
    `, [reservationIds, roomTypeIds]);
    await runtime.database.pool.query(`
      INSERT INTO booking_reservation_payment_attempts (
        id, reservation_id, reference, provider, method, amount_minor, currency, status,
        provider_ref, expires_at, success_kind, succeeded_at
      )
      SELECT attempt_id, reservation_id, 'booking-payment:reconcile:' || attempt_id::text,
        'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', 'reconcile-provider:' || attempt_id::text,
        clock_timestamp(), 'late', clock_timestamp()
      FROM unnest($1::uuid[], $2::uuid[]) AS seed(attempt_id, reservation_id)
    `, [attemptIds, reservationIds]);
    await runtime.database.pool.query(`
      INSERT INTO booking_reservation_refunds (
        id, reservation_id, payment_attempt_id, reason, provider, payment_provider_ref,
        amount_minor, currency, provider_request_ref, status, generation, requested_at, updated_at
      )
      SELECT refund_id, reservation_id, attempt_id, 'late_payment', 'booking-test-payment',
        'reconcile-provider:' || attempt_id::text, 24690, 'USD', 'booking-refund:' || refund_id::text,
        'pending', 1, clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day'
      FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS seed(refund_id, reservation_id, attempt_id)
    `, [refundIds, reservationIds, attemptIds]);
    const ordered = await runtime.database.pool.query<{ id: string }>(`
      SELECT id FROM booking_reservation_refunds WHERE id = ANY($1::uuid[]) ORDER BY requested_at, id
    `, [refundIds]);
    const oldestRefundId = ordered.rows[0]!.id;
    const deadJobId = randomUUID();
    await runtime.database.pool.query(`
      INSERT INTO platform_jobs (id, type, payload, dedupe_key, status, attempts, max_attempts, run_at)
      VALUES ($1, 'booking.reservation.process-refund', jsonb_build_object('refundId', $2::text, 'generation', 1),
        $3, 'dead', 5, 5, clock_timestamp())
    `, [deadJobId, oldestRefundId, `booking-reservation:refund:${oldestRefundId}:1`]);
    try {
      await expect(runtime.commands.execute<{ enqueued: number }>(
        'booking.reservation.reconcileRefunds', {}, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() },
      )).resolves.toEqual({ enqueued: 100 });
      await expect(runtime.database.pool.query('SELECT status FROM platform_jobs WHERE id = $1', [deadJobId]))
        .resolves.toMatchObject({ rows: [{ status: 'pending' }] });
      const firstPass = await runtime.database.pool.query<{ refund_id: string }>(`
        SELECT payload->>'refundId' AS refund_id
        FROM platform_jobs
        WHERE type = 'booking.reservation.process-refund' AND payload->>'refundId' = ANY($1::text[])
      `, [refundIds]);
      expect(firstPass.rows).toHaveLength(100);
      const laterRefundId = refundIds.find(refundId => !firstPass.rows.some(row => row.refund_id === refundId));
      expect(laterRefundId).toBeDefined();
      await runtime.database.pool.query("UPDATE booking_reservation_refunds SET status = 'failed' WHERE id = $1", [oldestRefundId]);
      await expect(runtime.commands.execute<{ enqueued: number }>(
        'booking.reservation.reconcileRefunds', {}, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() },
      )).resolves.toEqual({ enqueued: 100 });
      await expect(runtime.database.pool.query(`
        SELECT payload->>'refundId' AS refund_id FROM platform_jobs
        WHERE type = 'booking.reservation.process-refund' AND payload->>'refundId' = $1
      `, [laterRefundId])).resolves.toMatchObject({ rows: [{ refund_id: laterRefundId }] });
    } finally {
      await runtime.database.pool.query(`
        DELETE FROM platform_jobs
        WHERE type = 'booking.reservation.process-refund' AND payload->>'refundId' = ANY($1::text[])
      `, [refundIds]);
    }
  }, 120_000);

  it('keeps cancellation refund zero/full/partial decisions exact and rejects invalid or changed evidence', async () => {
    async function cancelledWinningPayment(code: string) {
      const fixture = await createReservation(code);
      const payment = await runtime.commands.execute<{ attempt: { id: string; reference: string; amountMinor: number } }>(
        'booking.reservation.startPayment', { reservationId: fixture.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(fixture.reservation.id) },
        { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
      );
      await clearPaymentAttemptJobs(fixture.reservation.id);
      await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: payment.attempt.reference, providerRef: `refund:cancellation:${code}`,
      });
      await runtime.database.pool.query("UPDATE booking_reservation_reservations SET status = 'cancelled' WHERE id = $1", [fixture.reservation.id]);
      return { reservationId: fixture.reservation.id, paymentAttemptId: payment.attempt.id, amountMinor: payment.attempt.amountMinor };
    }

    const zero = await cancelledWinningPayment('refund-cancellation-zero');
    await expect(createCancellationRefund({ ...zero, amountMinor: 0 })).resolves.toMatchObject({ refund: null, created: false });
    await expect(runtime.database.pool.query('SELECT id FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [zero.paymentAttemptId]))
      .resolves.toMatchObject({ rows: [] });

    const full = await cancelledWinningPayment('refund-cancellation-full');
    const fullResult = await createCancellationRefund(full);
    expect(fullResult).toMatchObject({ created: true, refund: {
      reason: 'reservation_cancellation', amountMinor: full.amountMinor, currency: 'USD', status: 'pending',
    } });

    const partial = await cancelledWinningPayment('refund-cancellation-partial');
    const partialAmount = 12_000;
    const partialResult = await createCancellationRefund({ ...partial, amountMinor: partialAmount });
    expect(partialResult).toMatchObject({ created: true, refund: {
      reason: 'reservation_cancellation', amountMinor: partialAmount, currency: 'USD', status: 'pending',
    } });
    await expect(createCancellationRefund({ ...partial, amountMinor: partialAmount - 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(createCancellationRefund({ ...partial, amountMinor: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });

    const overRefund = await cancelledWinningPayment('refund-cancellation-over-refund');
    await expect(createCancellationRefund({ ...overRefund, amountMinor: overRefund.amountMinor + 1 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const currencyMismatch = await cancelledWinningPayment('refund-cancellation-currency-mismatch');
    await runtime.database.pool.query("UPDATE booking_reservation_reservations SET currency = 'TWD' WHERE id = $1", [currencyMismatch.reservationId]);
    await expect(createCancellationRefund(currencyMismatch)).rejects.toMatchObject({ code: 'CONFLICT' });

    await Promise.all([zero, full, partial, overRefund, currencyMismatch].map(refund => clearRefundJobs(refund.reservationId)));
  }, 120_000);

  it('upgrades an SW-128 database through 0009, backfills classified receipts, and lets the public reconciler enqueue provider work', async () => {
    const upgradeContainer = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('booking_reservation_upgrade')
      .withUsername('booking')
      .withPassword('booking')
      .start();
    let legacyRuntime: Runtime | undefined;
    let upgradedRuntime: Runtime | undefined;
    try {
      const config = baseConfigSchema.parse({
        version: 1, store: { id: 'booking-reservation-upgrade', name: 'Booking Reservation Upgrade' },
        database: { url: upgradeContainer.getConnectionUri() }, logging: { level: 'error' },
        security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
      });
      const secrets = {
        get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? TEST_SECRET : undefined,
        has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
        listNames: () => ['SW_SIGNING_KEY_TEST'],
      };
      const upgradeKeyring = resolveKeyring(config, secrets)!;
      const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
      const quoteReservationBinding = bindBookingAvailabilityQuoteReservation(propertyBinding, QUOTE_LIMITS, upgradeKeyring);
      const roomNightOperationsBinding = bindModuleCapability(
        'booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, testRoomNightOperations,
      );
      const reservationModule = createBookingReservationModule(
        quoteReservationBinding, roomNightOperationsBinding, createBookingReservationAccess(upgradeKeyring),
        RETENTION_POLICY, bookingPaymentProvider,
      );
      const legacyReservationModule = {
        ...reservationModule,
        migrations: { ...bookingReservationMigrations, migrations: bookingReservationMigrations.migrations.slice(0, 8) },
        data: { owns: ['booking_reservation_reservations', 'booking_reservation_payment_attempts'] },
      };
      const options = {
        release: { id: 'booking-reservation-upgrade', version: '1.0.0', buildManifestChecksum: `sha256:${'7'.repeat(64)}` },
        roles: BASE_ROLES, config, secrets, logger: noopLogger, availableExtensions: {},
      };
      legacyRuntime = await createRuntime({
        ...options,
        modules: [
          createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, upgradeKeyring),
          createBookingPropertyModule(),
          legacyReservationModule,
        ],
      });
      await legacyRuntime.migrate();

      const lateReservationId = randomUUID();
      const lateAttemptId = randomUUID();
      const excessReservationId = randomUUID();
      const winnerAttemptId = randomUUID();
      const excessAttemptId = randomUUID();
      await legacyRuntime.database.pool.query(`
          INSERT INTO booking_reservation_reservations (
            id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
            booker_name, booker_email, booker_phone, primary_guest_name, status, payment_expires_at,
            currency, total_minor, nightly_prices, cancellation_policy, quote_fingerprint
          ) VALUES ($1, $2, '2026-10-01', '2026-10-02', 1, 1, 0,
            'Legacy Booker', 'legacy@example.test', '000', 'Legacy Guest', $3, clock_timestamp(),
            'USD', 24690, '[]'::jsonb, '{}'::jsonb, 'booking-quote-v1:legacy:${'a'.repeat(64)}')
        `, [lateReservationId, randomUUID(), 'expired']);
      await legacyRuntime.database.pool.query(`
          INSERT INTO booking_reservation_payment_attempts (
            id, reservation_id, reference, provider, method, amount_minor, currency, status,
            provider_ref, expires_at, success_kind, succeeded_at
          ) VALUES ($1, $2, $3, 'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', $4,
            clock_timestamp(), $5, clock_timestamp())
        `, [lateAttemptId, lateReservationId, 'booking-payment:legacy-late', 'legacy-provider:late', 'late']);
      await legacyRuntime.database.transaction(async tx => {
        await tx.execute(sql`
          INSERT INTO booking_reservation_reservations (
            id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
            booker_name, booker_email, booker_phone, primary_guest_name, status, payment_expires_at,
            currency, total_minor, nightly_prices, cancellation_policy, quote_fingerprint
          ) VALUES (${excessReservationId}, ${randomUUID()}, '2026-10-01', '2026-10-02', 1, 1, 0,
            'Legacy Booker', 'legacy@example.test', '000', 'Legacy Guest', 'confirmed', clock_timestamp(),
            'USD', 24690, '[]'::jsonb, '{}'::jsonb, ${`booking-quote-v1:legacy:${'a'.repeat(64)}`})
        `);
        await tx.execute(sql`
          INSERT INTO booking_reservation_payment_attempts (
            id, reservation_id, reference, provider, method, amount_minor, currency, status,
            provider_ref, expires_at, success_kind, succeeded_at
          ) VALUES (${winnerAttemptId}, ${excessReservationId}, 'booking-payment:legacy-winner',
            'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', 'legacy-provider:winner',
            clock_timestamp(), 'winning', clock_timestamp())
        `);
        await tx.execute(sql`
          INSERT INTO booking_reservation_payment_attempts (
            id, reservation_id, reference, provider, method, amount_minor, currency, status,
            provider_ref, expires_at, success_kind, succeeded_at
          ) VALUES (${excessAttemptId}, ${excessReservationId}, 'booking-payment:legacy-excess',
            'booking-test-payment', 'deferred', 24690, 'USD', 'succeeded', 'legacy-provider:excess',
            clock_timestamp(), 'excess', clock_timestamp())
        `);
        await tx.execute(sql`
          UPDATE booking_reservation_reservations
          SET winning_payment_attempt_id = ${winnerAttemptId}
          WHERE id = ${excessReservationId}
        `);
      });
      await legacyRuntime.close();
      legacyRuntime = undefined;

      upgradedRuntime = await createRuntime({
        ...options,
        modules: [
          createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, upgradeKeyring),
          createBookingPropertyModule(),
          reservationModule,
        ],
      });
      await expect(upgradedRuntime.migrate()).resolves.toEqual(expect.arrayContaining([
        'booking-reservation/0009_reservation_refunds',
        'booking-reservation/0010_refund_attempt_reservation_integrity',
      ]));
      const backfilled = await upgradedRuntime.database.pool.query<{
        refund_id: string; payment_attempt_id: string; reason: string; amount_minor: string; currency: string; status: string; provider_request_ref: string;
      }>(`
        SELECT id AS refund_id, payment_attempt_id, reason, amount_minor::text, currency, status, provider_request_ref
        FROM booking_reservation_refunds WHERE payment_attempt_id = ANY($1::uuid[]) ORDER BY payment_attempt_id
      `, [[lateAttemptId, excessAttemptId]]);
      expect(backfilled.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ payment_attempt_id: lateAttemptId, reason: 'late_payment', amount_minor: '24690', currency: 'USD', status: 'pending', provider_request_ref: expect.stringMatching(/^booking-refund:/) }),
        expect.objectContaining({ payment_attempt_id: excessAttemptId, reason: 'excess_payment', amount_minor: '24690', currency: 'USD', status: 'pending', provider_request_ref: expect.stringMatching(/^booking-refund:/) }),
      ]));
      await expect(upgradedRuntime.database.pool.query(`
        SELECT id FROM platform_jobs WHERE type = 'booking.reservation.process-refund'
      `)).resolves.toMatchObject({ rows: [] });

      await expect(upgradedRuntime.commands.execute<{ enqueued: number }>(
        'booking.reservation.reconcileRefunds', {}, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() },
      )).resolves.toEqual({ enqueued: 2 });
      const reconciled = await upgradedRuntime.database.pool.query<{ refund_id: string; generation: string }>(`
        SELECT payload->>'refundId' AS refund_id, payload->>'generation' AS generation
        FROM platform_jobs WHERE type = 'booking.reservation.process-refund' ORDER BY payload->>'refundId'
      `);
      expect(reconciled.rows).toEqual(backfilled.rows.map(refund => ({ refund_id: refund.refund_id, generation: '1' }))
        .sort((left, right) => left.refund_id.localeCompare(right.refund_id)));
    } finally {
      await Promise.allSettled([
        ...(legacyRuntime ? [legacyRuntime.close()] : []),
        ...(upgradedRuntime ? [upgradedRuntime.close()] : []),
        upgradeContainer.stop(),
      ]);
    }
  }, 120_000);

  it('classifies verified callbacks after completed expiry and cancellation as late payments', async () => {
    const expired = await createReservation('verified-callback-expiry-race');
    const expiredAttempt = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: expired.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(expired.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(expired.reservation.id);
    const now = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const overdue = new Date(now.rows[0]!.now.getTime() - 1_000);
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1', [expired.reservation.id, overdue]);
    await expect(expireReservation(expired.reservation.id, overdue.toISOString())).resolves.toEqual({ kind: 'expired' });
    const afterExpiry = recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: expiredAttempt.attempt.reference, providerRef: 'callback:expired',
    });
    await expect(afterExpiry).resolves.toMatchObject({ attempt: { id: expiredAttempt.attempt.id, status: 'succeeded' } });

    const cancelled = await createReservation('verified-callback-cancellation-race');
    const cancelledAttempt = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: cancelled.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(cancelled.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(cancelled.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: cancelled.reservation.id, refundAmountMinor: 0, reason: 'callback after cancellation',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    const afterCancellation = recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: cancelledAttempt.attempt.reference, providerRef: 'callback:cancelled',
    });
    await expect(afterCancellation).resolves.toMatchObject({ attempt: { id: cancelledAttempt.attempt.id, status: 'succeeded' } });
    const late = await runtime.database.pool.query<{ reservation_id: string; status: string; success_kind: string }>(`
      SELECT a.reservation_id, a.status, a.success_kind
      FROM booking_reservation_payment_attempts a WHERE a.id = ANY($1::uuid[]) ORDER BY a.id
    `, [[expiredAttempt.attempt.id, cancelledAttempt.attempt.id]]);
    expect(late.rows).toHaveLength(2);
    expect(late.rows.every(row => row.status === 'succeeded' && row.success_kind === 'late')).toBe(true);
    const lifecycle = await runtime.database.pool.query<{ id: string; status: string; winning_payment_attempt_id: string | null }>(
      'SELECT id, status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = ANY($1::uuid[])',
      [[expired.reservation.id, cancelled.reservation.id]],
    );
    expect(lifecycle.rows).toEqual(expect.arrayContaining([
      { id: expired.reservation.id, status: 'expired', winning_payment_attempt_id: null },
      { id: cancelled.reservation.id, status: 'cancelled', winning_payment_attempt_id: null },
    ]));
    expect(await reservedCounts(expired.roomType.id)).toEqual([0, 0]);
    expect(await reservedCounts(cancelled.roomType.id)).toEqual([0, 0]);
    const refundEvidence = await runtime.database.pool.query<{
      payment_attempt_id: string; reason: string; amount_minor: string; status: string;
    }>('SELECT payment_attempt_id, reason, amount_minor::text, status FROM booking_reservation_refunds WHERE payment_attempt_id = ANY($1::uuid[]) ORDER BY payment_attempt_id', [
      [expiredAttempt.attempt.id, cancelledAttempt.attempt.id],
    ]);
    expect(refundEvidence.rows).toEqual(expect.arrayContaining([
      { payment_attempt_id: expiredAttempt.attempt.id, reason: 'late_payment', amount_minor: '24690', status: 'pending' },
      { payment_attempt_id: cancelledAttempt.attempt.id, reason: 'late_payment', amount_minor: '24690', status: 'pending' },
    ]));
    await clearRefundJobs(expired.reservation.id);
    await clearRefundJobs(cancelled.reservation.id);

    const terminalAttemptsBefore = await runtime.database.pool.query<{
      id: string; status: string; success_kind: string; updated_at: Date;
    }>('SELECT id, status, success_kind, updated_at FROM booking_reservation_payment_attempts WHERE id = ANY($1::uuid[]) ORDER BY id', [
      [expiredAttempt.attempt.id, cancelledAttempt.attempt.id],
    ]);
    const staleDeadline = new Date(Date.now() + 60_000).toISOString();
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: expiredAttempt.attempt.reference, providerRef: 'stale:expired',
      instructions: [{ label: 'Account', value: 'stale' }], expiresAt: staleDeadline,
    })).resolves.toMatchObject({ attempt: { id: expiredAttempt.attempt.id, status: 'succeeded' } });
    await expect(recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: cancelledAttempt.attempt.reference, providerRef: 'stale:cancelled',
      instructions: [{ label: 'Account', value: 'stale' }], expiresAt: staleDeadline,
    })).resolves.toMatchObject({ attempt: { id: cancelledAttempt.attempt.id, status: 'succeeded' } });
    const terminalAttemptsAfter = await runtime.database.pool.query<typeof terminalAttemptsBefore.rows[0]>(
      'SELECT id, status, success_kind, updated_at FROM booking_reservation_payment_attempts WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[expiredAttempt.attempt.id, cancelledAttempt.attempt.id]],
    );
    expect(terminalAttemptsAfter.rows).toEqual(terminalAttemptsBefore.rows);
  }, 120_000);

  it('lets a verified callback confirm the Reservation before operator cancellation refunds the winner', async () => {
    const { roomType, reservation } = await createReservation('callback-cancellation-race-callback-first');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);

    const [callback, cancellation] = await raceUnderReservationLock(
      reservation.id,
      () => recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `callback:beats-cancel:${started.attempt.id}`,
      }),
      () => runtime.commands.execute<{ cancelled: true; refund: { amountMinor: number } | null }>(
        'booking.reservation.cancelByOperator', {
          reservationId: reservation.id, refundAmountMinor: 24_690, reason: 'callback beat cancellation',
        }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() },
      ),
    );
    const [callbackOutcome, cancellationOutcome] = await Promise.allSettled([callback, cancellation]);
    expect(callbackOutcome).toMatchObject({ status: 'fulfilled', value: { attempt: { id: started.attempt.id, status: 'succeeded' } } });
    expect(cancellationOutcome).toMatchObject({ status: 'fulfilled', value: { cancelled: true, refund: { amountMinor: 24_690 } } });

    try {
      const [reservationRow, attemptRow, refundRows, auditRows] = await Promise.all([
        runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string | null }>(
          'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id]),
        runtime.database.pool.query<{ status: string; success_kind: string }>(
          'SELECT status, success_kind FROM booking_reservation_payment_attempts WHERE id = $1', [started.attempt.id]),
        runtime.database.pool.query<{ reason: string; amount_minor: string; status: string }>(
          'SELECT reason, amount_minor::text, status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]),
        runtime.database.pool.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM platform_audit_log
          WHERE action = 'booking.reservation.operator-cancelled' AND resource_id = $1`, [reservation.id]),
      ]);
      expect(reservationRow.rows).toEqual([{ status: 'cancelled', winning_payment_attempt_id: started.attempt.id }]);
      expect(attemptRow.rows).toEqual([{ status: 'succeeded', success_kind: 'winning' }]);
      expect(refundRows.rows).toEqual([{ reason: 'reservation_cancellation', amount_minor: '24690', status: 'pending' }]);
      expect(auditRows.rows).toEqual([{ count: '1' }]);
      expect(await reservedCounts(roomType.id)).toEqual([0, 0]);

      await drainBookingNotificationWork();
      const lateNotifications = await runtime.database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM booking_reservation_notification_links WHERE payment_attempt_id = $1 AND kind = 'late-payment'",
        [started.attempt.id],
      );
      expect(lateNotifications.rows).toEqual([{ count: '0' }]);
    } finally {
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('cancels before a verified callback arrives and classifies the payment as a Late Payment', async () => {
    const { roomType, reservation } = await createReservation('callback-cancellation-race-cancel-first');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);

    const [cancellation, callback] = await raceUnderReservationLock(
      reservation.id,
      () => runtime.commands.execute<{ cancelled: true; refund: { amountMinor: number } | null }>(
        'booking.reservation.cancelByOperator', {
          reservationId: reservation.id, refundAmountMinor: 0, reason: 'cancellation beat callback',
        }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() },
      ),
      () => recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `callback:after-cancel:${started.attempt.id}`,
      }),
    );
    const [cancellationOutcome, callbackOutcome] = await Promise.allSettled([cancellation, callback]);
    expect(cancellationOutcome).toMatchObject({ status: 'fulfilled', value: { cancelled: true, refund: null } });
    expect(callbackOutcome).toMatchObject({ status: 'fulfilled', value: { attempt: { id: started.attempt.id, status: 'succeeded' } } });

    try {
      const [reservationRow, attemptRow, refundRows, auditRows] = await Promise.all([
        runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string | null }>(
          'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id]),
        runtime.database.pool.query<{ status: string; success_kind: string }>(
          'SELECT status, success_kind FROM booking_reservation_payment_attempts WHERE id = $1', [started.attempt.id]),
        runtime.database.pool.query<{ reason: string; amount_minor: string; status: string }>(
          'SELECT reason, amount_minor::text, status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]),
        runtime.database.pool.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM platform_audit_log
          WHERE action = 'booking.reservation.operator-cancelled' AND resource_id = $1`, [reservation.id]),
      ]);
      expect(reservationRow.rows).toEqual([{ status: 'cancelled', winning_payment_attempt_id: null }]);
      expect(attemptRow.rows).toEqual([{ status: 'succeeded', success_kind: 'late' }]);
      expect(refundRows.rows).toEqual([{ reason: 'late_payment', amount_minor: '24690', status: 'pending' }]);
      expect(auditRows.rows).toEqual([{ count: '1' }]);
      expect(await reservedCounts(roomType.id)).toEqual([0, 0]);

      await drainBookingNotificationWork();
      const alertRows = await runtime.database.pool.query<{ payment_attempt_id: string; mapping_status: string }>(
        "SELECT payment_attempt_id, mapping_status FROM booking_reservation_notification_links WHERE reservation_id = $1 AND kind = 'late-payment'",
        [reservation.id],
      );
      expect(alertRows.rows).toEqual([{ payment_attempt_id: started.attempt.id, mapping_status: 'requested' }]);
    } finally {
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('enforces success evidence and Reservation winner pointer integrity in PostgreSQL', async () => {
    const first = await createReservation('winner-integrity-first');
    const second = await createReservation('winner-integrity-second');
    const firstAttempt = await runtime.commands.execute<{ attempt: { id: string } }>(
      'booking.reservation.startPayment', { reservationId: first.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(first.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(first.reservation.id);
    await expect(runtime.database.pool.query(
      "UPDATE booking_reservation_payment_attempts SET success_kind = 'winning' WHERE id = $1", [firstAttempt.attempt.id],
    )).rejects.toThrow(/success_evidence/i);
    await expect(runtime.database.pool.query(
      "UPDATE booking_reservation_payment_attempts SET status = 'failed', success_kind = 'late', succeeded_at = clock_timestamp() WHERE id = $1",
      [firstAttempt.attempt.id],
    )).rejects.toThrow(/success_evidence/i);
    await expect(runtime.database.pool.query(
      "UPDATE booking_reservation_reservations SET status = 'confirmed', winning_payment_attempt_id = $2 WHERE id = $1",
      [first.reservation.id, firstAttempt.attempt.id],
    )).rejects.toThrow(/succeeded winning Attempt/i);
    await expect(runtime.database.pool.query(
      "UPDATE booking_reservation_reservations SET status = 'confirmed', winning_payment_attempt_id = $2 WHERE id = $1",
      [second.reservation.id, firstAttempt.attempt.id],
    )).rejects.toThrow(/winning_payment_attempt/i);
    await expect(runtime.database.pool.query(
      "UPDATE booking_reservation_payment_attempts SET status = 'succeeded', provider_ref = 'orphan-winner', success_kind = 'winning', succeeded_at = clock_timestamp() WHERE id = $1",
      [firstAttempt.attempt.id],
    )).rejects.toThrow(/winning Attempt must be selected/i);

    const selected = await createReservation('winner-integrity-selected');
    const selectedAttempt = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: selected.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(selected.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(selected.reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: selectedAttempt.attempt.reference, providerRef: 'selected-winner',
    });
    await runtime.database.transaction(tx => tx.execute(sql`
      UPDATE booking_reservation_reservations SET status = 'cancelled' WHERE id = ${selected.reservation.id}
    `));
    const cancelledWinner = await runtime.database.pool.query<{
      status: string; winning_payment_attempt_id: string; attempt_status: string; success_kind: string; succeeded_at: Date;
    }>(`
      SELECT r.status, r.winning_payment_attempt_id, a.status AS attempt_status, a.success_kind, a.succeeded_at
      FROM booking_reservation_reservations r
      JOIN booking_reservation_payment_attempts a ON a.id = r.winning_payment_attempt_id
      WHERE r.id = $1
    `, [selected.reservation.id]);
    expect(cancelledWinner.rows).toEqual([{
      status: 'cancelled', winning_payment_attempt_id: selectedAttempt.attempt.id,
      attempt_status: 'succeeded', success_kind: 'winning', succeeded_at: expect.any(Date),
    }]);
    await expect(runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET winning_payment_attempt_id = NULL WHERE id = $1', [selected.reservation.id],
    )).rejects.toThrow(/winner cannot be cleared/i);
  }, 120_000);

  it('rejects invalid methods and terminal Reservations without creating an Attempt', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    paymentMethods = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];
    paymentSetupError = undefined;
    const { reservation } = await createReservation('payment-attempt-invalid');
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'unknown', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);

    paymentMethods = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];

    paymentSetupError = new Error('payment provider is not configured');
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toThrow('payment provider is not configured');
    paymentSetupError = undefined;
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);

    const terminalCredential = await checkoutCredentialFor(reservation.id);
    await runtime.database.pool.query(
      "UPDATE booking_reservation_reservations SET status = 'cancelled' WHERE id = $1",
      [reservation.id],
    );
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: terminalCredential },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);
    expect(paymentInitiations).toEqual([]);
  }, 120_000);

  it('confirms the Reservation when a verified payment callback wins the lock race against the original expiry command', async () => {
    const { roomType, reservation } = await createReservation('callback-vs-expiry-callback-wins');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    const clock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const overdue = new Date(clock.rows[0]!.now.getTime() - 1_000).toISOString();
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, overdue],
    );

    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);

    const [callback, expiry] = await raceUnderReservationLock(
      reservation.id,
      () => recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `callback:winner:${started.attempt.id}`,
      }),
      () => expireReservation(reservation.id, overdue),
    );
    const [callbackOutcome, expiryOutcome] = await Promise.allSettled([callback, expiry]);
    expect(callbackOutcome).toMatchObject({ status: 'fulfilled', value: { attempt: { id: started.attempt.id, status: 'succeeded' } } });
    expect(expiryOutcome).toMatchObject({ status: 'fulfilled', value: { kind: 'noop' } });

    const [reservationRow, attemptRow, auditRows, refundRows] = await Promise.all([
      runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string | null }>(
        'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id]),
      runtime.database.pool.query<{ status: string; success_kind: string }>(
        'SELECT status, success_kind FROM booking_reservation_payment_attempts WHERE id = $1', [started.attempt.id]),
      runtime.database.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM platform_audit_log
        WHERE action = 'booking.reservation.expired' AND resource_id = $1`, [reservation.id]),
      runtime.database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]),
    ]);
    expect(reservationRow.rows).toEqual([{ status: 'confirmed', winning_payment_attempt_id: started.attempt.id }]);
    expect(attemptRow.rows).toEqual([{ status: 'succeeded', success_kind: 'winning' }]);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    expect(auditRows.rows).toEqual([{ count: '0' }]);
    expect(refundRows.rows).toEqual([{ count: '0' }]);
  }, 120_000);

  it('classifies a verified payment callback as a Late Payment when the original expiry command wins the lock race', async () => {
    const { roomType, reservation } = await createReservation('callback-vs-expiry-expiry-wins');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(reservation.id);
    const clock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const overdue = new Date(clock.rows[0]!.now.getTime() - 1_000).toISOString();
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, overdue],
    );

    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);

    const [expiry, callback] = await raceUnderReservationLock(
      reservation.id,
      () => expireReservation(reservation.id, overdue),
      () => recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `callback:late:${started.attempt.id}`,
      }),
    );
    const [expiryOutcome, callbackOutcome] = await Promise.allSettled([expiry, callback]);
    expect(expiryOutcome).toMatchObject({ status: 'fulfilled', value: { kind: 'expired' } });
    expect(callbackOutcome).toMatchObject({ status: 'fulfilled', value: { attempt: { id: started.attempt.id, status: 'succeeded' } } });

    try {
      const [reservationRow, attemptRow, refundRows, auditRows] = await Promise.all([
        runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string | null }>(
          'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id]),
        runtime.database.pool.query<{ status: string; success_kind: string }>(
          'SELECT status, success_kind FROM booking_reservation_payment_attempts WHERE id = $1', [started.attempt.id]),
        runtime.database.pool.query<{ reason: string; amount_minor: string; status: string }>(
          'SELECT reason, amount_minor::text, status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]),
        runtime.database.pool.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM platform_audit_log
          WHERE action = 'booking.reservation.expired' AND resource_id = $1`, [reservation.id]),
      ]);
      expect(reservationRow.rows).toEqual([{ status: 'expired', winning_payment_attempt_id: null }]);
      expect(attemptRow.rows).toEqual([{ status: 'succeeded', success_kind: 'late' }]);
      expect(refundRows.rows).toEqual([{ reason: 'late_payment', amount_minor: '24690', status: 'pending' }]);
      expect(auditRows.rows).toEqual([{ count: '1' }]);
      expect(await reservedCounts(roomType.id)).toEqual([0, 0]);

      await drainBookingNotificationWork();
      const alertRows = await runtime.database.pool.query<{ payment_attempt_id: string; mapping_status: string }>(
        "SELECT payment_attempt_id, mapping_status FROM booking_reservation_notification_links WHERE reservation_id = $1 AND kind = 'late-payment'",
        [reservation.id],
      );
      expect(alertRows.rows).toEqual([{ payment_attempt_id: started.attempt.id, mapping_status: 'requested' }]);
    } finally {
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('expires active Attempts before releasing the Reservation Room Nights and retains a late confirmation', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    const { roomType, reservation } = await createReservation('payment-attempt-reservation-expiry');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    const clock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const expiredAt = new Date(clock.rows[0]!.now.getTime() - 1_000);
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, expiredAt],
    );
    await expect(expireReservation(reservation.id, expiredAt.toISOString()))
      .resolves.toEqual({ kind: 'expired' });
    expect(await paymentAttemptsFor(reservation.id)).toMatchObject([{
      id: started.attempt.id, status: 'expired',
    }]);
    expect(await reservedCounts(roomType.id)).toEqual([0, 0]);
    const worker = new Worker(runtime, { workerId: `booking-payment-late-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(paymentInitiations).toEqual([]);
    await runtime.commands.execute(
      'booking.reservation.recordPaymentResult',
      {
        attemptId: started.attempt.id,
        provider: bookingPaymentProviderId,
        result: { status: 'confirmed', providerRef: `booking-test:${started.attempt.reference}` },
      },
      { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() },
    );
    const lateAttempt = await runtime.database.pool.query<{ status: string; provider_ref: string; success_kind: string; succeeded_at: Date }>(`
      SELECT status, provider_ref, success_kind, succeeded_at
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(lateAttempt.rows).toEqual([{
      status: 'succeeded', provider_ref: `booking-test:${started.attempt.reference}`,
      success_kind: 'late', succeeded_at: expect.any(Date),
    }]);
    await clearPaymentAttemptJobs(reservation.id);
    await clearRefundJobs(reservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('dead-letters a queued Attempt when the configured Provider changes before invocation', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    const { reservation } = await createReservation('payment-attempt-provider-change');
    const started = await runtime.commands.execute<{ attempt: { id: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    bookingPaymentProviderId = 'booking-replaced-payment';
    try {
      const worker = new Worker(runtime, { workerId: `booking-payment-provider-change-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      await expect(worker.runJobs()).resolves.toMatchObject({ processed: 0, failed: 1 });
      expect(paymentInitiations).toEqual([]);
      expect(await paymentAttemptsFor(reservation.id)).toMatchObject([{
        id: started.attempt.id, status: 'created', provider_ref: null,
      }]);
      const job = await runtime.database.pool.query<{ status: string }>(`
        SELECT status FROM platform_jobs
        WHERE type = 'booking.reservation.process-payment' AND payload->>'attemptId' = $1
      `, [started.attempt.id]);
      expect(job.rows).toEqual([{ status: 'dead' }]);
    } finally {
      bookingPaymentProviderId = 'booking-test-payment';
      await clearPaymentAttemptJobs(reservation.id);
    }
  }, 120_000);

  it('blocks parallel active Attempts and retains transport uncertainty on the same reference', async () => {
    paymentInitiations.length = 0;
    paymentResult = () => {
      throw new Error('test transport uncertainty');
    };
    const { reservation } = await createReservation('payment-attempt-active');
    const [left, right] = await Promise.allSettled([
      runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
        'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
        { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
      ),
      runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
        'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
        { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
      ),
    ]);
    const created = [left, right].find((result): result is PromiseFulfilledResult<{ attempt: { id: string; reference: string } }> => result.status === 'fulfilled');
    const blocked = [left, right].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(created?.value.attempt.reference).toEqual(expect.any(String));
    expect(blocked?.reason).toMatchObject({ code: 'CONFLICT' });

    const worker = new Worker(runtime, { workerId: `booking-payment-uncertain-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 0, failed: 1 });
    expect(paymentInitiations).toHaveLength(1);
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await paymentAttemptsFor(reservation.id)).toMatchObject([{
      id: created?.value.attempt.id, status: 'created', provider_ref: null,
    }]);
    await clearPaymentAttemptJobs(reservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('revalidates, snapshots and creates atomically without leaking Booker PII', async () => {
    const { roomType, quote } = await createFixture('res-main');
    const submitted = inputFor(quote);
    const key = randomUUID();
    const created = await runtime.commands.execute<{
      kind: 'created'; reservation: { id: string; status: string; paymentExpiresAt: string; quote: BookingQuote };
    }>('booking.reservation.create', submitted, { actor: RESERVATION_ACTOR, idempotencyKey: key });

    expect(created.kind).toBe('created');
    expect(created.reservation.status).toBe('pending_payment');
    expect(Date.parse(created.reservation.paymentExpiresAt) - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(Date.parse(created.reservation.paymentExpiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(created.reservation.quote).toEqual(quote);
    expect(JSON.stringify(created)).not.toMatch(/Private Booker Name|private\.booker@example\.test|\+1 555 0100|Private Guest Name|Private arrival note/);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);

    const replay = await runtime.commands.execute('booking.reservation.create', submitted, {
      actor: RESERVATION_ACTOR, idempotencyKey: key,
    });
    expect(replay).toEqual(created);
    const stored = await runtime.database.pool.query<{ status: string; currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown }>(
      `SELECT status, currency, total_minor::float8 AS total_minor, nightly_prices, cancellation_policy
       FROM booking_reservation_reservations WHERE id = $1`, [created.reservation.id],
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'pending_payment', currency: quote.currency, total_minor: quote.totalMinor,
      nightly_prices: quote.nights, cancellation_policy: quote.cancellationPolicy,
    });

    const idempotency = await runtime.database.pool.query<{ response: unknown }>(
      `SELECT response FROM platform_idempotency WHERE command_name = 'booking.reservation.create' AND key = $1`, [key],
    );
    expect(JSON.stringify(idempotency.rows[0]?.response)).not.toMatch(/Private Booker Name|private\.booker@example\.test|\+1 555 0100/);
    const audits = await runtime.database.pool.query<{ payload: unknown }>(
      `SELECT payload FROM platform_audit_log WHERE action = 'booking.reservation.create-requested' AND resource_id = $1`,
      [created.reservation.id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows[0]?.payload)).not.toMatch(/Private Booker Name|private\.booker@example\.test|\+1 555 0100|Private Guest Name|Private arrival note/);

    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
      roomTypeId: roomType.id, baseNightlyPriceMinor: 20_000,
    }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
    const persistedAfterSourceChange = await runtime.database.pool.query<{ currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown }>(
      `SELECT currency, total_minor::float8 AS total_minor, nightly_prices, cancellation_policy
       FROM booking_reservation_reservations WHERE id = $1`, [created.reservation.id],
    );
    expect(persistedAfterSourceChange.rows[0]).toMatchObject({
      currency: quote.currency, total_minor: quote.totalMinor,
      nightly_prices: quote.nights, cancellation_policy: quote.cancellationPolicy,
    });

    const { roomType: largeTotalRoom, quote: largeTotalQuote } = await createFixture('res-large-total', 3, 2_000_000_000);
    expect(largeTotalQuote.totalMinor).toBe(4_000_000_000);
    const largeTotal = await runtime.commands.execute<{ kind: string; reservation?: { id: string; quote: BookingQuote } }>(
      'booking.reservation.create', inputFor(largeTotalQuote), {
        actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
      },
    );
    expect(largeTotal.kind).toBe('created');
    expect(largeTotal.reservation?.quote.totalMinor).toBe(4_000_000_000);
    const persistedLargeTotal = await runtime.database.pool.query<{ total_minor: number }>(
      'SELECT total_minor::float8 AS total_minor FROM booking_reservation_reservations WHERE room_type_id = $1',
      [largeTotalRoom.id],
    );
    expect(persistedLargeTotal.rows[0]?.total_minor).toBe(4_000_000_000);

    const { roomType: staleRoom, quote: staleQuote } = await createFixture('res-stale');
    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
      roomTypeId: staleRoom.id, baseNightlyPriceMinor: 15_000,
    }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
    const stale = await runtime.commands.execute<{ kind: string }>('booking.reservation.create', inputFor(staleQuote), {
      actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
    });
    expect(stale.kind).toBe('stale');
    expect(await reservationCount(staleRoom.id)).toBe(0);
    expect(await reservedCounts(staleRoom.id)).toEqual([0, 0]);

    const { roomType: unavailableRoom, quote: unavailableQuote } = await createFixture('res-unavailable', 1);
    const unavailableInput = inputFor(unavailableQuote);
    const first = await runtime.commands.execute<{ kind: string }>('booking.reservation.create', unavailableInput, {
      actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
    });
    const second = await runtime.commands.execute<{ kind: string }>('booking.reservation.create', unavailableInput, {
      actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
    });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('unavailable');
    expect(await reservationCount(unavailableRoom.id)).toBe(1);
    expect(await reservedCounts(unavailableRoom.id)).toEqual([1, 1]);

    const { roomType: invalidRoom, quote: invalidQuote } = await createFixture('res-invalid');
    const invalidInput = inputFor(invalidQuote);
    await expect(runtime.commands.execute('booking.reservation.create', {
      ...invalidInput,
      quote: { ...invalidInput.quote, adults: 5 },
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.reservation.create', {
      ...invalidInput,
      booker: { ...invalidInput.booker, email: 'not-an-email' },
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await reservationCount(invalidRoom.id)).toBe(0);
    expect(await reservedCounts(invalidRoom.id)).toEqual([0, 0]);

    const { roomType: rollbackRoom, quote: rollbackQuote } = await createFixture('res-rollback');
    const triggerName = `booking_reservation_fail_${randomUUID().replace(/-/g, '')}`;
    const functionName = `${triggerName}_fn`;
    await runtime.database.pool.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced reservation insert failure'; END; $$`);
    await runtime.database.pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.booking_reservation_reservations FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try {
      await expect(runtime.commands.execute('booking.reservation.create', inputFor(rollbackQuote), {
        actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
      })).rejects.toThrow('forced reservation insert failure');
    } finally {
      await runtime.database.pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON public.booking_reservation_reservations`);
      await runtime.database.pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
    expect(await reservationCount(rollbackRoom.id)).toBe(0);
    expect(await reservedCounts(rollbackRoom.id)).toEqual([0, 0]);

    const { roomType: concurrentRoom, quote: concurrentQuote } = await createFixture('res-concurrent', 1);
    const concurrentInput = inputFor(concurrentQuote);
    const concurrent = await Promise.allSettled([
      runtime.commands.execute<{ kind: string }>('booking.reservation.create', concurrentInput, {
        actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
      }),
      runtime.commands.execute<{ kind: string }>('booking.reservation.create', concurrentInput, {
        actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
      }),
    ]);
    const outcomes = concurrent.flatMap(item => item.status === 'fulfilled' ? [item.value.kind] : []);
    expect(concurrent.filter(item => item.status === 'rejected')).toHaveLength(0);
    expect(outcomes.sort()).toEqual(['created', 'unavailable']);
    expect(await reservationCount(concurrentRoom.id)).toBe(1);
    expect(await reservedCounts(concurrentRoom.id)).toEqual([1, 1]);
  }, 120_000);

  it('schedules and executes one-shot expiry, then fences duplicate and stale deadline work', async () => {
    const { roomType, reservation } = await createReservation('expiry-happy');
    const dedupeKey = `booking-reservation:expire:${reservation.id}`;
    const queued = await runtime.database.pool.query<{
      status: string; payload: { reservationId: string; expectedPaymentExpiresAt: string }; run_at: Date; payload_version: number;
    }>('SELECT status, payload, run_at, payload_version FROM platform_jobs WHERE dedupe_key = $1', [dedupeKey]);
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({
      status: 'pending', payload_version: 1,
      payload: { reservationId: reservation.id, expectedPaymentExpiresAt: reservation.paymentExpiresAt },
    });
    expect(queued.rows[0]?.run_at.toISOString()).toBe(reservation.paymentExpiresAt);

    const databaseClock = await runtime.database.pool.query<{ now: Date }>('SELECT pg_catalog.clock_timestamp() AS now');
    const overdueDeadline = new Date(databaseClock.rows[0]!.now.getTime() - 1_000);
    const expectedPaymentExpiresAt = overdueDeadline.toISOString();
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, overdueDeadline],
    );
    await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
      type: 'booking.reservation.expire',
      payload: { reservationId: reservation.id, expectedPaymentExpiresAt },
      dedupeKey,
      runAt: new Date(Date.now() - 1_000),
      replaceExisting: true,
    }));

    const worker = new Worker(runtime, { workerId: 'booking-reservation-expiry-test', concurrency: 1 });
    // Queue eligibility and expiry both use PostgreSQL time even if the Worker host clock trails it.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(overdueDeadline.getTime() - 60_000) });
    try {
      await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    } finally {
      vi.useRealTimers();
    }
    const expired = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(expired.rows[0]?.status).toBe('expired');
    expect(await reservedCounts(roomType.id)).toEqual([0, 0]);
    const audit = await runtime.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_audit_log
       WHERE action = 'booking.reservation.expired' AND resource_id = $1`, [reservation.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    const completedJob = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM platform_jobs WHERE dedupe_key = $1', [dedupeKey],
    );
    expect(completedJob.rows[0]?.status).toBe('completed');

    await expect(expireReservation(reservation.id, expectedPaymentExpiresAt)).resolves.toEqual({ kind: 'noop' });

    const { roomType: futureRoom, reservation: futureReservation } = await createReservation('expiry-future');
    await expect(expireReservation(futureReservation.id, futureReservation.paymentExpiresAt)).resolves.toEqual({ kind: 'noop' });
    expect(await reservedCounts(futureRoom.id)).toEqual([1, 1]);

    for (const [code, status] of [['expiry-confirmed', 'confirmed'], ['expiry-cancelled', 'cancelled']] as const) {
      const { roomType: stateRoom, reservation: stateReservation } = await createReservation(code);
      const oldDeadline = new Date(Date.now() - 60_000);
      await runtime.database.pool.query(
        'UPDATE booking_reservation_reservations SET status = $2, payment_expires_at = $3 WHERE id = $1',
        [stateReservation.id, status, oldDeadline],
      );
      await expect(expireReservation(stateReservation.id, oldDeadline.toISOString())).resolves.toEqual({ kind: 'noop' });
      expect(await reservedCounts(stateRoom.id)).toEqual([1, 1]);
    }

    const { roomType: concurrentRoom, reservation: concurrentReservation } = await createReservation('expiry-concurrent');
    const concurrentDeadline = new Date(Date.now() - 60_000);
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [concurrentReservation.id, concurrentDeadline],
    );
    const concurrentResults = await Promise.all([
      expireReservation(concurrentReservation.id, concurrentDeadline.toISOString()),
      expireReservation(concurrentReservation.id, concurrentDeadline.toISOString()),
    ]);
    expect(concurrentResults.map(result => result.kind).sort()).toEqual(['expired', 'noop']);
    expect(await reservedCounts(concurrentRoom.id)).toEqual([0, 0]);

    const { roomType: renewedRoom, reservation: renewedReservation } = await createReservation('expiry-renewed');
    const staleDeadline = new Date(Date.now() - 120_000);
    const renewedDeadline = new Date(Date.now() - 60_000);
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [renewedReservation.id, renewedDeadline],
    );
    await expect(expireReservation(renewedReservation.id, staleDeadline.toISOString())).resolves.toEqual({ kind: 'noop' });
    expect(await reservedCounts(renewedRoom.id)).toEqual([1, 1]);
    const renewedState = await runtime.database.pool.query<{ status: string; payment_expires_at: Date }>(
      'SELECT status, payment_expires_at FROM booking_reservation_reservations WHERE id = $1', [renewedReservation.id],
    );
    expect(renewedState.rows[0]?.status).toBe('pending_payment');
    expect(renewedState.rows[0]?.payment_expires_at.getTime()).toBe(renewedDeadline.getTime());
  }, 120_000);

  it('rolls back Reservation, audit, supply, and command idempotency when release fails', async () => {
    const { roomType, reservation } = await createReservation('expiry-release-failure');
    const deadline = new Date(Date.now() - 60_000);
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, deadline],
    );
    const idempotencyKey = randomUUID();
    failAfterRoomNightRelease = true;
    try {
      await expect(expireReservation(reservation.id, deadline.toISOString(), idempotencyKey))
        .rejects.toThrow('forced post-release failure');
    } finally {
      failAfterRoomNightRelease = false;
    }

    const unchanged = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(unchanged.rows[0]?.status).toBe('pending_payment');
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    const audit = await runtime.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_audit_log
       WHERE action = 'booking.reservation.expired' AND resource_id = $1`, [reservation.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(0);
    const idempotency = await runtime.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_idempotency
       WHERE command_name = 'booking.reservation.expire' AND key = $1`, [idempotencyKey],
    );
    expect(Number(idempotency.rows[0]?.count)).toBe(0);

    await expect(expireReservation(reservation.id, deadline.toISOString(), idempotencyKey))
      .resolves.toEqual({ kind: 'expired' });
    expect(await reservedCounts(roomType.id)).toEqual([0, 0]);
  }, 120_000);

  it('redeems a signed Access Grant once and stores only a hash for management authorization', async () => {
    const { reservation } = await createReservation('access-happy');
    const issued = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const redeemed = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: issued.grantToken,
    }));
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: redeemed.managementCredential,
    }))).resolves.toEqual({ reservationId: reservation.id });

    const stored = await runtime.database.pool.query<{
      access_generation: number; access_grant_nonce: string; access_grant_expires_at: Date;
      access_grant_used_at: Date | null; management_token_hash: string | null; row_json: string;
    }>(`SELECT access_generation, access_grant_nonce, access_grant_expires_at, access_grant_used_at,
               management_token_hash, to_jsonb(reservation)::text AS row_json
        FROM booking_reservation_reservations AS reservation WHERE id = $1`, [reservation.id]);
    expect(stored.rows[0]).toMatchObject({
      access_generation: 1,
      access_grant_expires_at: issued.expiresAt,
    });
    expect(stored.rows[0]?.access_grant_nonce).toBeTruthy();
    expect(stored.rows[0]?.access_grant_used_at).toBeInstanceOf(Date);
    expect(stored.rows[0]?.management_token_hash).toBe(sha256Hex(redeemed.managementCredential));
    expect(stored.rows[0]?.row_json).not.toContain(redeemed.managementCredential);
    expect(stored.rows[0]?.row_json).not.toContain(issued.grantToken);

    const persistedOutputs = await runtime.database.pool.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM public.platform_idempotency
         WHERE response::text LIKE '%' || $1 || '%' OR response::text LIKE '%' || $2 || '%'
        UNION ALL
        SELECT 1 FROM public.platform_audit_log
         WHERE payload::text LIKE '%' || $1 || '%' OR payload::text LIKE '%' || $2 || '%'
        UNION ALL
        SELECT 1 FROM public.platform_outbox
         WHERE payload::text LIKE '%' || $1 || '%' OR payload::text LIKE '%' || $2 || '%'
        UNION ALL
        SELECT 1 FROM public.platform_jobs
         WHERE payload::text LIKE '%' || $1 || '%' OR payload::text LIKE '%' || $2 || '%'
      ) AS present
    `, [redeemed.managementCredential, issued.grantToken]);
    expect(persistedOutputs.rows[0]?.present).toBe(false);
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: issued.grantToken,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: issued.grantToken,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: '',
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: randomUUID(),
      managementCredential: redeemed.managementCredential,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: 'RES-123:private.booker@example.test',
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  }, 120_000);

  it('rejects invalid, expired, wrong-purpose, replayed, and superseded Access Grants', async () => {
    const { reservation } = await createReservation('access-invalid');
    const issued = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const currentGrant = await runtime.database.pool.query<{ access_grant_nonce: string }>(
      'SELECT access_grant_nonce FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    const claims = {
      version: 1,
      reservationId: reservation.id,
      generation: issued.generation,
      nonce: currentGrant.rows[0]!.access_grant_nonce,
    };
    const signed = (payload: unknown, purpose = BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE, expiresAt = issued.expiresAt) =>
      signValue(keyring, { purpose, payload: JSON.stringify(payload), expiresAt });
    const tampered = `${issued.grantToken.slice(0, -1)}${issued.grantToken.endsWith('A') ? 'B' : 'A'}`;
    const invalidGrants = [
      tampered,
      signed(claims, 'password-reset'),
      signed({ version: 1, reservationId: reservation.id, generation: issued.generation }),
      signed({ ...claims, nonce: randomUUID() }),
      signed({ ...claims, generation: issued.generation + 1 }),
    ];
    for (const grantToken of invalidGrants) {
      await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken })))
        .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }

    const { reservation: expiredReservation } = await createReservation('access-expired');
    const expiredGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: expiredReservation.id, ttlMs: 15 * 60_000,
    }));
    const expiredState = await runtime.database.pool.query<{ access_grant_nonce: string }>(
      'SELECT access_grant_nonce FROM booking_reservation_reservations WHERE id = $1', [expiredReservation.id],
    );
    const expiredAt = new Date(Math.floor((Date.now() - 5_000) / 1_000) * 1_000);
    const expiredToken = signValue(keyring, {
      purpose: BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
      payload: JSON.stringify({
        version: 1,
        reservationId: expiredReservation.id,
        generation: expiredGrant.generation,
        nonce: expiredState.rows[0]!.access_grant_nonce,
      }),
      expiresAt: expiredAt,
    });
    await runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET access_grant_expires_at = $2 WHERE id = $1',
      [expiredReservation.id, expiredAt],
    );
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: expiredToken })))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const replacement = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: issued.grantToken,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: replacement.grantToken,
    }))).resolves.toMatchObject({ managementCredential: expect.stringMatching(/^brm1\.2\.[A-Za-z0-9_-]{43}$/) });
  }, 120_000);

  it('keeps caller-selected Access Grant lifetimes within one minute and one hour bounds', async () => {
    const { reservation } = await createReservation('access-ttl');
    const beforeMinimum = await runtime.database.pool.query<{ now: Date }>(
      'SELECT pg_catalog.clock_timestamp() AS now',
    );
    const minimum = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 60_000,
    }));
    expect(minimum.expiresAt.getTime() - beforeMinimum.rows[0]!.now.getTime()).toBeGreaterThanOrEqual(60_000);
    await expect(runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 59_999,
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const maximum = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 60 * 60_000,
    }));
    const afterMaximum = await runtime.database.pool.query<{ now: Date }>(
      'SELECT pg_catalog.clock_timestamp() AS now',
    );
    const effectiveMaximum = maximum.expiresAt.getTime() - afterMaximum.rows[0]!.now.getTime();
    expect(effectiveMaximum).toBeLessThanOrEqual(60 * 60_000);
    await expect(runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 60 * 60_000 + 1,
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, 120_000);

  it('serializes concurrent redemption and rolls back a consumed Grant with its credential hash', async () => {
    const { reservation: concurrentReservation } = await createReservation('access-concurrent');
    const concurrentGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: concurrentReservation.id, ttlMs: 15 * 60_000,
    }));
    const attempts = await Promise.allSettled([
      runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: concurrentGrant.grantToken })),
      runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: concurrentGrant.grantToken })),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const { reservation: rollbackReservation } = await createReservation('access-rollback');
    const rollbackGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: rollbackReservation.id, ttlMs: 15 * 60_000,
    }));
    await expect(runtime.database.transaction(async tx => {
      await reservationAccess.redeemGrant(tx, { grantToken: rollbackGrant.grantToken });
      throw new Error('rollback Access Grant redemption');
    })).rejects.toThrow('rollback Access Grant redemption');
    const rolledBack = await runtime.database.pool.query<{ access_grant_used_at: Date | null; management_token_hash: string | null }>(
      'SELECT access_grant_used_at, management_token_hash FROM booking_reservation_reservations WHERE id = $1',
      [rollbackReservation.id],
    );
    expect(rolledBack.rows[0]).toEqual({ access_grant_used_at: null, management_token_hash: null });
    const retried = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: rollbackGrant.grantToken,
    }));
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: rollbackReservation.id,
      managementCredential: retried.managementCredential,
    }))).resolves.toEqual({ reservationId: rollbackReservation.id });
  }, 120_000);

  it('reissue revokes an existing management credential', async () => {
    const { reservation } = await createReservation('access-reissue');
    const firstGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const firstCredential = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: firstGrant.grantToken,
    }));
    await runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: firstCredential.managementCredential,
    }));

    const secondGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    expect(secondGrant.generation).toBe(firstGrant.generation + 1);
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id,
      managementCredential: firstCredential.managementCredential,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: firstGrant.grantToken,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  }, 120_000);

  it('resends an Access Grant only to the current Booker, rotates management access, and keeps delivery failure operator-visible', async () => {
    const { reservation } = await createReservation('access-grant-resend');
    const initialGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const initialManagement = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: initialGrant.grantToken,
    }));
    const owner = signedInAccountActor(randomUUID(), 'customer');
    await runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential: initialManagement.managementCredential,
    }, { actor: owner, idempotencyKey: randomUUID() });
    await runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id,
      booker: { name: 'Current Booker', email: 'current.booker@example.test', phone: '+1 555 0152' },
    }, { actor: owner, idempotencyKey: randomUUID() });

    // This command rotates a revocable credential. The descriptor therefore
    // rejects every direct Bus call that does not provide its transaction-bound
    // replay guard, before it can claim idempotency or change Reservation state.
    const missingGuardKey = randomUUID();
    const beforeMissingGuard = await runtime.database.pool.query<{ access_generation: number; notifications: string }>(`
      SELECT access_generation,
        (SELECT count(*)::text FROM platform_notifications
         WHERE reference LIKE 'booking-reservation:access-grant-resend:' || id::text || ':%') AS notifications
      FROM booking_reservation_reservations WHERE id = $1
    `, [reservation.id]);
    await expect(runtime.commands.execute('booking.reservation.resendAccessGrant', {
      reservationId: reservation.id,
    }, { actor: owner, idempotencyKey: missingGuardKey })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const afterMissingGuard = await runtime.database.pool.query<{
      access_generation: number; notifications: string; idempotency: string; audits: string;
    }>(`
      SELECT access_generation,
        (SELECT count(*)::text FROM platform_notifications
         WHERE reference LIKE 'booking-reservation:access-grant-resend:' || id::text || ':%') AS notifications,
        (SELECT count(*)::text FROM platform_idempotency
         WHERE command_name = 'booking.reservation.resendAccessGrant' AND key = $2) AS idempotency,
        (SELECT count(*)::text FROM platform_audit_log
         WHERE resource_id = id::text AND action = 'booking.reservation.access-grant-resent') AS audits
      FROM booking_reservation_reservations WHERE id = $1
    `, [reservation.id, missingGuardKey]);
    expect(afterMissingGuard.rows).toEqual([{
      access_generation: beforeMissingGuard.rows[0]!.access_generation,
      notifications: beforeMissingGuard.rows[0]!.notifications,
      idempotency: '0',
      audits: '0',
    }]);

    const executeResend = (
      input: { reservationId: string; managementCredential?: string },
      commandActor: Actor,
      idempotencyKey: string,
    ) => runtime.commands.execute('booking.reservation.resendAccessGrant', input, {
      actor: commandActor,
      idempotencyKey,
      beforeIdempotency: tx => authorizeResendBookingReservationAccessGrant(tx, commandActor, input, reservationAccess).then(() => undefined),
    });

    await expect(executeResend({ reservationId: reservation.id }, signedInAccountActor(), randomUUID()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const managementKey = randomUUID();
    await expect(executeResend({
      reservationId: reservation.id, managementCredential: initialManagement.managementCredential,
    }, RESERVATION_ACTOR, managementKey)).resolves.toEqual({ reservationId: reservation.id, accepted: true });
    // Rechecking before a cached replay matters: resend rotation revokes the
    // credential which authorized the original request.
    await expect(executeResend({
      reservationId: reservation.id, managementCredential: initialManagement.managementCredential,
    }, RESERVATION_ACTOR, managementKey)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const afterManagementResend = await runtime.database.pool.query<{
      reference: string; recipient_email: string; variables: { accessGrant: string };
    }>(`SELECT reference, recipient_email, variables FROM platform_notifications
       WHERE template_id = 'booking.reservation.access-grant-resend' ORDER BY created_at DESC LIMIT 1`);
    expect(afterManagementResend.rows).toEqual([expect.objectContaining({
      reference: expect.stringContaining(`:${reservation.id}:`), recipient_email: 'current.booker@example.test',
      variables: expect.objectContaining({ accessGrant: expect.any(String) }),
    })]);
    const managementResend = afterManagementResend.rows[0]!;
    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: reservation.id, managementCredential: initialManagement.managementCredential,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const ownerKey = randomUUID();
    await expect(executeResend({ reservationId: reservation.id }, owner, ownerKey))
      .resolves.toEqual({ reservationId: reservation.id, accepted: true });
    await expect(executeResend({ reservationId: reservation.id }, owner, ownerKey))
      .resolves.toEqual({ reservationId: reservation.id, accepted: true });
    const resends = await runtime.database.pool.query<{
      reference: string; recipient_email: string; variables: { accessGrant: string };
    }>(`SELECT reference, recipient_email, variables FROM platform_notifications
       WHERE template_id = 'booking.reservation.access-grant-resend' ORDER BY created_at`);
    expect(resends.rows).toHaveLength(2);
    expect(resends.rows.every(row => row.recipient_email === 'current.booker@example.test')).toBe(true);
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: managementResend.variables.accessGrant,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const latestGrant = resends.rows[1]!.variables.accessGrant;
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: latestGrant })))
      .resolves.toMatchObject({ managementCredential: expect.stringMatching(/^brm1\./) });

    const persisted = await runtime.database.pool.query<{ payload: unknown; response: unknown }>(`
      SELECT a.payload, i.response FROM platform_audit_log a
      CROSS JOIN platform_idempotency i
      WHERE a.resource_id = $1 AND a.action = 'booking.reservation.access-grant-resent'
        AND i.command_name = 'booking.reservation.resendAccessGrant'
    `, [reservation.id]);
    expect(JSON.stringify(persisted.rows)).not.toMatch(/current\.booker@example\.test|brm1\.|accessGrant/i);

    await runtime.database.pool.query(`UPDATE platform_notification_deliveries d
      SET status = 'failed', last_error = 'mail rejected current.booker@example.test'
      FROM platform_notifications n WHERE n.id = d.notification_id AND n.reference = $1`, [resends.rows[1]!.reference]);
    const evidence = await runtime.queries.execute<any>('platform.notifications.listDeliveries', {
      reference: resends.rows[1]!.reference, limit: 20, offset: 0,
    }, { actor: actor(['notifications:read']) });
    expect(evidence.items).toEqual([expect.objectContaining({
      status: 'failed', recipientMasked: 'c***@example.test', lastError: 'mail rejected c***@example.test',
    })]);
    expect(JSON.stringify(evidence)).not.toContain('current.booker@example.test');
    await expect(runtime.database.pool.query<{ owner_account_id: string }>(
      'SELECT owner_account_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    )).resolves.toMatchObject({ rows: [{ owner_account_id: owner.id.slice('user:'.length) }] });
  }, 120_000);

  it('claims with both management proof and Account identity, then scopes reads and audits owner updates', async () => {
    const { reservation } = await createReservation('access-claim');
    const issued = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const { managementCredential } = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: issued.grantToken,
    }));
    const owner = signedInAccountActor(randomUUID(), 'customer');
    const otherAccount = signedInAccountActor();

    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential, accountId: owner.id.slice('user:'.length),
    }, { actor: owner, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential: `${managementCredential}invalid`,
    }, { actor: owner, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const unclaimed = await runtime.database.pool.query<{ owner_account_id: string | null }>(
      'SELECT owner_account_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(unclaimed.rows[0]?.owner_account_id).toBeNull();

    const managedRead = await runtime.queries.execute<{
      reservation: { id: string; booker: { name: string; email: string } };
    }>('booking.reservation.getManaged', { reservationId: reservation.id, managementCredential }, { actor: RESERVATION_ACTOR });
    expect(managedRead.reservation).toMatchObject({
      id: reservation.id,
      booker: { name: 'Private Booker Name', email: 'private.booker@example.test' },
    });
    await expect(runtime.queries.execute('booking.reservation.getManaged', {
      reservationId: reservation.id, managementCredential: `${managementCredential}invalid`,
    }, { actor: RESERVATION_ACTOR })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const claimKey = randomUUID();
    const claimed = await runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential,
    }, { actor: owner, idempotencyKey: claimKey });
    expect(claimed).toEqual({ reservationId: reservation.id, kind: 'claimed' });
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential,
    }, { actor: owner, idempotencyKey: claimKey })).resolves.toEqual(claimed);
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential,
    }, { actor: owner, idempotencyKey: randomUUID() }))
      .resolves.toEqual({ reservationId: reservation.id, kind: 'already-owner' });
    const postClaimManagedRead = await runtime.queries.execute<{
      reservation: { id: string; status: string };
    }>('booking.reservation.getManaged', { reservationId: reservation.id, managementCredential }, { actor: RESERVATION_ACTOR });
    expect(postClaimManagedRead.reservation).toMatchObject({ id: reservation.id, status: 'pending_payment' });
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential,
    }, { actor: otherAccount, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    const owned = await runtime.queries.execute<{
      reservation: { id: string; booker: { name: string; email: string }; quote: { roomCount: number } };
    }>('booking.reservation.getOwned', { reservationId: reservation.id }, { actor: owner });
    expect(owned.reservation).toMatchObject({
      id: reservation.id,
      booker: { name: 'Private Booker Name', email: 'private.booker@example.test' },
      quote: { roomCount: 1 },
    });
    await expect(runtime.queries.execute('booking.reservation.getOwned', { reservationId: reservation.id }, { actor: otherAccount }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id, primaryGuestName: 'Cross Account Update',
    }, { actor: otherAccount, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id,
      managementCredential,
      primaryGuestName: 'Management Session Guest',
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).resolves.toEqual({
      reservationId: reservation.id,
      updatedFields: ['primaryGuestName'],
    });

    const updated = await runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id,
      booker: { name: 'Updated Booker', email: 'updated.booker@example.test', phone: '+1 555 0101' },
      primaryGuestName: 'Updated Guest',
      accommodationNotes: 'Updated notes',
    }, { actor: owner, idempotencyKey: randomUUID() });
    expect(updated).toEqual({
      reservationId: reservation.id,
      updatedFields: ['booker', 'primaryGuestName', 'accommodationNotes'],
    });
    const updatedOwned = await runtime.queries.execute<{
      reservation: {
        booker: { name: string; email: string; phone: string };
        primaryGuestName: string; accommodationNotes: string | null;
        quote: { roomCount: number; totalMinor: number; nights: unknown[] };
      };
    }>('booking.reservation.getOwned', { reservationId: reservation.id }, { actor: owner });
    expect(updatedOwned.reservation).toMatchObject({
      booker: { name: 'Updated Booker', email: 'updated.booker@example.test', phone: '+1 555 0101' },
      primaryGuestName: 'Updated Guest',
      accommodationNotes: 'Updated notes',
      quote: { roomCount: 1, totalMinor: 24_690, nights: expect.any(Array) },
    });

    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id, primaryGuestName: 'Must Not Persist', roomCount: 2,
    }, { actor: owner, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const audit = await runtime.database.pool.query<{ action: string; payload: unknown }>(
      `SELECT action, payload FROM platform_audit_log
       WHERE resource_id = $1 AND action IN ('booking.reservation.claimed', 'booking.reservation.managed-details-updated')
       ORDER BY action`, [reservation.id],
    );
    expect(audit.rows).toHaveLength(3);
    expect(JSON.stringify(audit.rows)).not.toMatch(/updated\.booker@example\.test|Updated Booker|Updated Guest|Management Session Guest|Updated notes|555 0101|brm1\./);
    expect(audit.rows.filter(row => row.action === 'booking.reservation.managed-details-updated').map(row => row.payload))
      .toEqual(expect.arrayContaining([
        { accessMethod: 'account-owner', changedFields: ['booker', 'primaryGuestName', 'accommodationNotes'] },
        { accessMethod: 'management-credential', changedFields: ['primaryGuestName'] },
      ]));

    const claimReplay = await runtime.database.pool.query<{ response: unknown }>(
      `SELECT response FROM platform_idempotency WHERE command_name = 'booking.reservation.claim' AND key = $1`,
      [claimKey],
    );
    expect(claimReplay.rows[0]?.response).toEqual(claimed);
    expect(JSON.stringify(claimReplay.rows[0]?.response)).not.toMatch(/Account|Booker|email|credential/i);

    await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: reservation.id,
      managementCredential,
      primaryGuestName: 'Revoked Credential Update',
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const afterInvalidUpdate = await runtime.queries.execute<{
      reservation: { primaryGuestName: string; quote: { roomCount: number } };
    }>('booking.reservation.getOwned', { reservationId: reservation.id }, { actor: owner });
    expect(afterInvalidUpdate.reservation).toMatchObject({
      primaryGuestName: 'Updated Guest', quote: { roomCount: 1 },
    });
    await expect(runtime.queries.execute('booking.reservation.getManaged', {
      reservationId: reservation.id, managementCredential,
    }, { actor: RESERVATION_ACTOR })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  }, 120_000);

  it('serializes competing Account claims and allows every existing Reservation status', async () => {
    const { reservation: competing } = await createReservation('claim-competing');
    const grant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: competing.id, ttlMs: 15 * 60_000,
    }));
    const { managementCredential } = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: grant.grantToken,
    }));
    const accounts = [signedInAccountActor(), signedInAccountActor()];
    const attempts = await Promise.allSettled(accounts.map(account => runtime.commands.execute('booking.reservation.claim', {
      reservationId: competing.id, managementCredential,
    }, { actor: account, idempotencyKey: randomUUID() })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winnerIndex = attempts.findIndex(result => result.status === 'fulfilled');
    expect(attempts[winnerIndex === 0 ? 1 : 0]).toMatchObject({
      status: 'rejected', reason: { code: 'CONFLICT' },
    });
    const owner = await runtime.database.pool.query<{ owner_account_id: string }>(
      'SELECT owner_account_id FROM booking_reservation_reservations WHERE id = $1', [competing.id],
    );
    expect(owner.rows[0]?.owner_account_id).toBe(accounts[winnerIndex]?.id.slice('user:'.length));

    for (const status of ['confirmed', 'expired', 'cancelled'] as const) {
      const { reservation } = await createReservation(`claim-${status}`);
      await runtime.database.pool.query(
        'UPDATE booking_reservation_reservations SET status = $2 WHERE id = $1', [reservation.id, status],
      );
      const statusGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
        reservationId: reservation.id, ttlMs: 15 * 60_000,
      }));
      const statusAccess = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
        grantToken: statusGrant.grantToken,
      }));
      await expect(runtime.commands.execute('booking.reservation.claim', {
        reservationId: reservation.id, managementCredential: statusAccess.managementCredential,
      }, { actor: signedInAccountActor(), idempotencyKey: randomUUID() })).resolves.toMatchObject({ kind: 'claimed' });
    }
  }, 180_000);

  it('rejects claim attempts after management access is revoked', async () => {
    const { reservation } = await createReservation('claim-revoked');
    const firstGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const staleAccess = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: firstGrant.grantToken,
    }));
    await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    await expect(runtime.commands.execute('booking.reservation.claim', {
      reservationId: reservation.id, managementCredential: staleAccess.managementCredential,
    }, { actor: signedInAccountActor(), idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const persisted = await runtime.database.pool.query<{ owner_account_id: string | null }>(
      'SELECT owner_account_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(persisted.rows[0]?.owner_account_id).toBeNull();
  }, 120_000);

  it('retains payment winner evidence while redacting eligible Reservation PII once', async () => {
    paymentInitiations.length = 0;
    paymentResult = input => ({ status: 'confirmed', providerRef: `booking-test:${input.reference}` });
    try {
      const { reservation } = await createReservation('retention-payment-evidence');
      const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
        'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(reservation.id) },
        { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
      );
      const paymentWorker = new Worker(runtime, {
        workerId: `booking-retention-payment-${randomUUID().slice(0, 8)}`, concurrency: 1,
      });
      await expect(paymentWorker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });

      const attemptBefore = await runtime.database.pool.query<{
        id: string; reservation_id: string; reference: string; provider: string; method: string;
        amount_minor: number; currency: string; status: string; provider_ref: string | null;
        expires_at: Date; success_kind: string | null; succeeded_at: Date | null;
      }>(`
        SELECT id, reservation_id, reference, provider, method, amount_minor::float8 AS amount_minor,
               currency, status, provider_ref, expires_at, success_kind, succeeded_at
        FROM booking_reservation_payment_attempts WHERE id = $1
      `, [started.attempt.id]);
      expect(attemptBefore.rows).toEqual([{
        id: started.attempt.id, reservation_id: reservation.id, reference: started.attempt.reference,
        provider: bookingPaymentProviderId, method: 'deferred', amount_minor: 24_690, currency: 'USD',
        status: 'succeeded', provider_ref: `booking-test:${started.attempt.reference}`,
        expires_at: new Date(reservation.paymentExpiresAt),
        success_kind: 'winning', succeeded_at: expect.any(Date),
      }]);
      const paymentAuditBefore = await runtime.database.pool.query<{
        action: string; resource_type: string; resource_id: string; payload: unknown;
      }>(`
        SELECT action, resource_type, resource_id, payload
        FROM platform_audit_log
        WHERE action = 'booking.reservation.payment-result-recorded' AND resource_id = $1
      `, [started.attempt.id]);
      expect(paymentAuditBefore.rows).toHaveLength(1);

      // Move only the frozen stay dates back; retention still gets its clock from PostgreSQL.
      await makeRetentionEligible(reservation.id);
      const reservationFactsBefore = await runtime.database.pool.query<{
        status: string; winning_payment_attempt_id: string | null; check_in_local_date: string; check_out_local_date: string;
        currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown;
        quote_fingerprint: string;
      }>(`
        SELECT status, winning_payment_attempt_id, check_in_local_date::text, check_out_local_date::text, currency,
               total_minor::float8 AS total_minor, nightly_prices, cancellation_policy, quote_fingerprint
        FROM booking_reservation_reservations WHERE id = $1
      `, [reservation.id]);

      await expect(enqueueAndRunRetentionJob(`booking-retention-payment-evidence:${randomUUID()}`))
        .resolves.toMatchObject({ failed: 0 });

      const attemptAfter = await runtime.database.pool.query<typeof attemptBefore.rows[0]>(`
        SELECT id, reservation_id, reference, provider, method, amount_minor::float8 AS amount_minor,
               currency, status, provider_ref, expires_at, success_kind, succeeded_at
        FROM booking_reservation_payment_attempts WHERE id = $1
      `, [started.attempt.id]);
      expect(attemptAfter.rows).toEqual(attemptBefore.rows);
      const paymentAuditAfter = await runtime.database.pool.query<typeof paymentAuditBefore.rows[0]>(`
        SELECT action, resource_type, resource_id, payload
        FROM platform_audit_log
        WHERE action = 'booking.reservation.payment-result-recorded' AND resource_id = $1
      `, [started.attempt.id]);
      expect(paymentAuditAfter.rows).toEqual(paymentAuditBefore.rows);

      const redacted = await runtime.database.pool.query<{
        booker_name: string | null; booker_email: string | null; booker_phone: string | null;
        primary_guest_name: string | null; accommodation_notes: string | null; owner_account_id: string | null;
        pii_anonymized_at: Date | null; status: string; winning_payment_attempt_id: string | null; check_in_local_date: string; check_out_local_date: string;
        currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown;
        quote_fingerprint: string;
      }>(`
        SELECT booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes,
               owner_account_id, pii_anonymized_at, status, winning_payment_attempt_id, check_in_local_date::text,
               check_out_local_date::text, currency, total_minor::float8 AS total_minor,
               nightly_prices, cancellation_policy, quote_fingerprint
        FROM booking_reservation_reservations WHERE id = $1
      `, [reservation.id]);
      expect(redacted.rows[0]).toMatchObject({
        booker_name: null, booker_email: null, booker_phone: null, primary_guest_name: null,
        accommodation_notes: null, owner_account_id: null, pii_anonymized_at: expect.any(Date),
      });
      expect(redacted.rows[0]).toMatchObject(reservationFactsBefore.rows[0]);

      const redactionAudits = await runtime.database.pool.query<{ payload: unknown }>(`
        SELECT payload FROM platform_audit_log
        WHERE action = 'booking.reservation.pii-anonymized' AND resource_id = $1
      `, [reservation.id]);
      expect(redactionAudits.rows).toHaveLength(1);
      expect(redactionAudits.rows[0]?.payload).toMatchObject({
        redactedFields: ['bookerName', 'bookerEmail', 'bookerPhone', 'primaryGuestName', 'accommodationNotes'],
        ownershipUnlinked: true, managementAccessRevoked: true,
      });
      expect(JSON.stringify(redactionAudits.rows)).not.toMatch(
        /Private Booker Name|private\.booker@example\.test|\+1 555 0100|Private Guest Name|Private arrival note|booking-payment:/,
      );
    } finally {
      paymentResult = defaultPaymentResult;
    }
  }, 120_000);

  it('retains cancelled lifecycle, real refund header and invocation evidence while redacting eligible Reservation PII', async () => {
    refundInvocations.length = 0;
    refundResult = { status: 'succeeded', providerRefundRef: 'booking-test-refund:retention' };
    try {
      const { reservation } = await createReservation('retention-cancellation-refund-evidence');
      const managementCredential = await managementCredentialFor(reservation.id);
      const owner = signedInAccountActor();
      await runtime.commands.execute('booking.reservation.claim', {
        reservationId: reservation.id, managementCredential,
      }, { actor: owner, idempotencyKey: randomUUID() });
      const winner = await confirmReservationForCancellation(reservation.id);
      const cancellation = await runtime.commands.execute<{
        reservationId: string; cancelled: true; refund: { id: string; amountMinor: number; currency: string } | null;
      }>('booking.reservation.cancelByOperator', {
        reservationId: reservation.id, refundAmountMinor: 12_345, reason: 'retention refund evidence fixture',
      }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
      expect(cancellation).toEqual({
        reservationId: reservation.id, cancelled: true,
        refund: { id: expect.any(String), amountMinor: 12_345, currency: 'USD' },
      });

      const refundWorker = new Worker(runtime, {
        workerId: `booking-retention-refund-${randomUUID().slice(0, 8)}`, concurrency: 1,
      });
      const isFixtureRefundInvocation = (input: PaymentRefundInputV2) => input.providerRef === `callback:cancel:${winner.id}`;
      for (let round = 0; round < 10 && !refundInvocations.some(isFixtureRefundInvocation); round += 1) await refundWorker.runJobs();
      const fixtureRefundInvocations = refundInvocations.filter(isFixtureRefundInvocation);
      expect(fixtureRefundInvocations).toEqual([expect.objectContaining({
        providerRef: `callback:cancel:${winner.id}`, amount: 12_345, currency: 'USD',
        reference: expect.stringMatching(/^booking-refund:/),
      })]);

      const evidenceBefore = await runtime.database.pool.query<{
        reservation_status: string; winning_payment_attempt_id: string | null; check_in_local_date: string; check_out_local_date: string;
        currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown; quote_fingerprint: string;
        attempt_id: string; attempt_status: string; attempt_success_kind: string | null; attempt_provider_ref: string | null;
        refund_id: string; refund_reason: string; refund_amount_minor: number; refund_currency: string; refund_status: string;
        provider_request_ref: string; provider_refund_ref: string | null; invocation_outcome: string; worker_attempt: number;
      }>(`
        SELECT r.status AS reservation_status, r.winning_payment_attempt_id, r.check_in_local_date::text,
               r.check_out_local_date::text, r.currency, r.total_minor::float8 AS total_minor,
               r.nightly_prices, r.cancellation_policy, r.quote_fingerprint,
               a.id AS attempt_id, a.status AS attempt_status, a.success_kind AS attempt_success_kind,
               a.provider_ref AS attempt_provider_ref, f.id AS refund_id, f.reason AS refund_reason,
               f.amount_minor::float8 AS refund_amount_minor, f.currency AS refund_currency, f.status AS refund_status,
               f.provider_request_ref, f.provider_refund_ref, i.outcome AS invocation_outcome, i.worker_attempt
        FROM booking_reservation_reservations r
        JOIN booking_reservation_payment_attempts a ON a.id = r.winning_payment_attempt_id
        JOIN booking_reservation_refunds f ON f.reservation_id = r.id AND f.payment_attempt_id = a.id
        JOIN booking_reservation_refund_invocations i ON i.refund_id = f.id
        WHERE r.id = $1
      `, [reservation.id]);
      expect(evidenceBefore.rows).toEqual([{
        reservation_status: 'cancelled', winning_payment_attempt_id: winner.id,
        check_in_local_date: expect.any(String), check_out_local_date: expect.any(String),
        currency: 'USD', total_minor: 24_690, nightly_prices: expect.any(Object), cancellation_policy: expect.any(Object),
        quote_fingerprint: expect.any(String), attempt_id: winner.id, attempt_status: 'succeeded',
        attempt_success_kind: 'winning', attempt_provider_ref: `callback:cancel:${winner.id}`,
        refund_id: cancellation.refund!.id, refund_reason: 'reservation_cancellation', refund_amount_minor: 12_345,
        refund_currency: 'USD', refund_status: 'succeeded', provider_request_ref: fixtureRefundInvocations[0]!.reference,
        provider_refund_ref: 'booking-test-refund:retention', invocation_outcome: 'succeeded', worker_attempt: 1,
      }]);
      const auditBefore = await runtime.database.pool.query<{ action: string; resource_id: string; payload: unknown }>(`
        SELECT action, resource_id, payload FROM platform_audit_log
        WHERE (action = 'booking.reservation.verified-payment-outcome-recorded' AND payload->>'reference' = $1)
           OR (action = 'booking.reservation.refund-invocation-recorded' AND resource_id = $2)
        ORDER BY action
      `, [winner.reference, cancellation.refund!.id]);
      expect(auditBefore.rows.map(row => row.action).sort()).toEqual([
        'booking.reservation.refund-invocation-recorded', 'booking.reservation.verified-payment-outcome-recorded',
      ]);

      // Preserve the terminal lifecycle while making only the frozen stay dates retention-eligible.
      const databaseNow = await runtime.database.pool.query<{ now: Date }>('SELECT now() AS now');
      const checkout = addDays(propertyLocalDate(databaseNow.rows[0]!.now), -2);
      await runtime.database.pool.query(`
        UPDATE booking_reservation_reservations
        SET check_in_local_date = $2, check_out_local_date = $3
        WHERE id = $1
      `, [reservation.id, addDays(checkout, -2), checkout]);
      const evidenceAtRedaction = [{
        ...evidenceBefore.rows[0]!, check_in_local_date: addDays(checkout, -2), check_out_local_date: checkout,
      }];

      await expect(enqueueAndRunRetentionJob(`booking-retention-cancellation-refund:${randomUUID()}`))
        .resolves.toMatchObject({ failed: 0 });

      const redacted = await runtime.database.pool.query<{
        booker_name: string | null; booker_email: string | null; booker_phone: string | null;
        primary_guest_name: string | null; accommodation_notes: string | null; owner_account_id: string | null;
        access_generation: number; access_grant_nonce: string | null; access_grant_expires_at: Date | null;
        access_grant_used_at: Date | null; management_token_hash: string | null; pii_anonymized_at: Date | null;
      }>(`
        SELECT booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes, owner_account_id,
               access_generation, access_grant_nonce, access_grant_expires_at, access_grant_used_at,
               management_token_hash, pii_anonymized_at
        FROM booking_reservation_reservations WHERE id = $1
      `, [reservation.id]);
      expect(redacted.rows).toEqual([{
        booker_name: null, booker_email: null, booker_phone: null, primary_guest_name: null,
        accommodation_notes: null, owner_account_id: null, access_generation: 0, access_grant_nonce: null,
        access_grant_expires_at: null, access_grant_used_at: null, management_token_hash: null,
        pii_anonymized_at: expect.any(Date),
      }]);

      const evidenceAfter = await runtime.database.pool.query<typeof evidenceBefore.rows[0]>(`
        SELECT r.status AS reservation_status, r.winning_payment_attempt_id, r.check_in_local_date::text,
               r.check_out_local_date::text, r.currency, r.total_minor::float8 AS total_minor,
               r.nightly_prices, r.cancellation_policy, r.quote_fingerprint,
               a.id AS attempt_id, a.status AS attempt_status, a.success_kind AS attempt_success_kind,
               a.provider_ref AS attempt_provider_ref, f.id AS refund_id, f.reason AS refund_reason,
               f.amount_minor::float8 AS refund_amount_minor, f.currency AS refund_currency, f.status AS refund_status,
               f.provider_request_ref, f.provider_refund_ref, i.outcome AS invocation_outcome, i.worker_attempt
        FROM booking_reservation_reservations r
        JOIN booking_reservation_payment_attempts a ON a.id = r.winning_payment_attempt_id
        JOIN booking_reservation_refunds f ON f.reservation_id = r.id AND f.payment_attempt_id = a.id
        JOIN booking_reservation_refund_invocations i ON i.refund_id = f.id
        WHERE r.id = $1
      `, [reservation.id]);
      expect(evidenceAfter.rows).toEqual(evidenceAtRedaction);
      const auditAfter = await runtime.database.pool.query<typeof auditBefore.rows[0]>(`
        SELECT action, resource_id, payload FROM platform_audit_log
        WHERE (action = 'booking.reservation.verified-payment-outcome-recorded' AND payload->>'reference' = $1)
           OR (action = 'booking.reservation.refund-invocation-recorded' AND resource_id = $2)
        ORDER BY action
      `, [winner.reference, cancellation.refund!.id]);
      expect(auditAfter.rows).toEqual(auditBefore.rows);
      const redactionAudit = await runtime.database.pool.query<{ payload: unknown }>(`
        SELECT payload FROM platform_audit_log
        WHERE action = 'booking.reservation.pii-anonymized' AND resource_id = $1
      `, [reservation.id]);
      expect(redactionAudit.rows).toHaveLength(1);
      expect(JSON.stringify(redactionAudit.rows)).not.toMatch(
        /Private Booker Name|private\.booker@example\.test|\+1 555 0100|Private Guest Name|Private arrival note|brm1\./,
      );
    } finally {
      refundResult = { status: 'succeeded', providerRefundRef: 'booking-test-refund' };
      refundError = undefined;
    }
  }, 120_000);

  it('drains more than one retention batch, preserves Reservation facts, and revokes local access once', async () => {
    const { reservation: ownedReservation } = await createReservation('retention-owned');
    const { reservation: grantReservation } = await createReservation('retention-unredeemed-grant');
    const databaseNow = await runtime.database.pool.query<{ now: Date }>('SELECT now() AS now');
    const today = propertyLocalDate(databaseNow.rows[0]!.now);
    const checkout = addDays(today, -2);
    const checkin = addDays(checkout, -2);
    await runtime.database.pool.query(`
      UPDATE booking_reservation_reservations
      SET status = 'confirmed', check_in_local_date = $2, check_out_local_date = $3
      WHERE id = $1
    `, [ownedReservation.id, checkin, checkout]);
    await runtime.database.pool.query(`
      UPDATE booking_reservation_reservations
      SET status = 'confirmed', check_in_local_date = $2, check_out_local_date = $3
      WHERE id = $1
    `, [grantReservation.id, checkin, checkout]);

    const grant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: ownedReservation.id, ttlMs: 15 * 60_000,
    }));
    const { managementCredential } = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: grant.grantToken,
    }));
    const owner = signedInAccountActor(randomUUID(), 'customer');
    await runtime.commands.execute('booking.reservation.claim', {
      reservationId: ownedReservation.id, managementCredential,
    }, { actor: owner, idempotencyKey: randomUUID() });
    const unusedGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: grantReservation.id, ttlMs: 15 * 60_000,
    }));

    const cloneIds = await cloneReservations(ownedReservation.id, 100);
    const reservationIds = [ownedReservation.id, grantReservation.id, ...cloneIds];
    const before = await runtime.database.pool.query<{
      id: string; status: string; check_in_local_date: string; check_out_local_date: string;
      currency: string; total_minor: number; nightly_prices: unknown; cancellation_policy: unknown;
      quote_fingerprint: string;
    }>(`
      SELECT id, status, check_in_local_date::text, check_out_local_date::text, currency,
             total_minor::float8 AS total_minor, nightly_prices, cancellation_policy, quote_fingerprint
      FROM booking_reservation_reservations WHERE id = $1
    `, [ownedReservation.id]);
    expect(before.rows).toHaveLength(1);

    const initialDedupeKey = `booking-retention-first:${randomUUID()}`;
    const retentionWorker = await enqueueRetentionJob(initialDedupeKey);
    await expect(retentionWorker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    const initialJob = await runtime.database.pool.query<{
      occurrence_id: string; payload: { bucket: number; scheduledFor: string };
    }>(
      'SELECT occurrence_id, payload FROM platform_jobs WHERE dedupe_key = $1', [initialDedupeKey],
    );
    const replayedBatch = await runtime.commands.execute<{
      scanned: number; anonymized: number; hasMore: boolean; nextId: string | null;
    }>('booking.reservation.anonymizeExpiredPii', {
      afterId: null,
      runId: initialJob.rows[0]!.occurrence_id,
      bucket: initialJob.rows[0]!.payload.bucket,
      scheduledFor: initialJob.rows[0]!.payload.scheduledFor,
    }, {
      actor: SYSTEM_ACTOR,
      channel: 'worker',
      idempotencyKey: `booking-reservation:retention-command:${initialJob.rows[0]!.occurrence_id}:start`,
    });
    expect(replayedBatch).toMatchObject({ scanned: 100, hasMore: true, nextId: expect.any(String) });
    const continuation = await runtime.database.pool.query<{
      status: string; dedupe_key: string; payload: { runId: string; afterId: string; scheduledFor: string; bucket: number };
    }>(`
      SELECT status, dedupe_key, payload FROM platform_jobs
      WHERE dedupe_key LIKE $1
    `, [`booking-reservation:retention:${initialJob.rows[0]!.occurrence_id}:%`]);
    expect(continuation.rows).toHaveLength(1);
    expect(continuation.rows[0]).toMatchObject({
      status: 'pending',
      payload: {
        runId: initialJob.rows[0]!.occurrence_id,
        afterId: expect.any(String),
        scheduledFor: expect.any(String),
        bucket: expect.any(Number),
      },
    });
    expect(continuation.rows[0]!.dedupe_key).toContain(`:${continuation.rows[0]!.payload.afterId}`);
    const continuationIndex = await runtime.database.pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'booking_reservation_retention_candidate_idx'
    `);
    expect(continuationIndex.rows[0]?.indexdef).toMatch(/WHERE \(pii_anonymized_at IS NULL\)/i);
    const restartedWorker = new Worker(runtime, {
      workerId: `booking-retention-restart-${randomUUID().slice(0, 8)}`, concurrency: 1,
    });
    const continuationDrain = await drainRetentionJobs(restartedWorker);
    expect(continuationDrain.failed).toBe(0);
    expect(continuationDrain.processed).toBeGreaterThan(0);
    const continuationStatus = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM platform_jobs WHERE dedupe_key = $1', [continuation.rows[0]!.dedupe_key],
    );
    expect(continuationStatus.rows[0]?.status).toBe('completed');

    const redacted = await runtime.database.pool.query<{
      id: string; booker_name: string | null; booker_email: string | null; booker_phone: string | null;
      primary_guest_name: string | null; accommodation_notes: string | null; owner_account_id: string | null;
      pii_anonymized_at: Date | null; access_generation: number; access_grant_nonce: string | null;
      access_grant_expires_at: Date | null; access_grant_used_at: Date | null; management_token_hash: string | null;
      status: string; check_in_local_date: string; check_out_local_date: string; currency: string;
      total_minor: number; nightly_prices: unknown; cancellation_policy: unknown; quote_fingerprint: string;
    }>(`
      SELECT id, booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes,
             owner_account_id, pii_anonymized_at, access_generation, access_grant_nonce,
             access_grant_expires_at, access_grant_used_at, management_token_hash, status,
             check_in_local_date::text, check_out_local_date::text, currency,
             total_minor::float8 AS total_minor, nightly_prices, cancellation_policy, quote_fingerprint
      FROM booking_reservation_reservations WHERE id = ANY($1::uuid[])
    `, [reservationIds]);
    expect(redacted.rows).toHaveLength(102);
    expect(redacted.rows.every(row => row.booker_name === null && row.booker_email === null
      && row.booker_phone === null && row.primary_guest_name === null && row.accommodation_notes === null
      && row.owner_account_id === null && row.pii_anonymized_at instanceof Date
      && row.access_generation === 0 && row.access_grant_nonce === null && row.access_grant_expires_at === null
      && row.access_grant_used_at === null && row.management_token_hash === null)).toBe(true);
    expect(redacted.rows.find(row => row.id === ownedReservation.id)).toMatchObject({
      status: 'confirmed', check_in_local_date: checkin, check_out_local_date: checkout,
      currency: before.rows[0]!.currency, total_minor: before.rows[0]!.total_minor,
      nightly_prices: before.rows[0]!.nightly_prices, cancellation_policy: before.rows[0]!.cancellation_policy,
      quote_fingerprint: before.rows[0]!.quote_fingerprint,
    });

    const auditRows = await runtime.database.pool.query<{ resource_id: string; payload: unknown }>(`
      SELECT resource_id, payload FROM platform_audit_log
      WHERE action = 'booking.reservation.pii-anonymized' AND resource_id = ANY($1::text[])
    `, [reservationIds]);
    expect(auditRows.rows).toHaveLength(102);
    expect(new Set(auditRows.rows.map(row => row.resource_id))).toEqual(new Set(reservationIds));
    expect(auditRows.rows.every(row => {
      const payload = JSON.stringify(row.payload);
      return payload.includes('"ownershipUnlinked":true')
        && payload.includes('"managementAccessRevoked":true');
    })).toBe(true);
    expect(JSON.stringify(auditRows.rows)).not.toMatch(/Private Booker Name|private\.booker@example\.test|Private Guest Name|Private arrival note|managementCredential|grantToken/);

    await expect(runtime.database.transaction(tx => reservationAccess.authorizeManagement(tx, {
      reservationId: ownedReservation.id, managementCredential,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: ownedReservation.id, ttlMs: 15 * 60_000,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: unusedGrant.grantToken,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.queries.execute('booking.reservation.getManaged', {
      reservationId: ownedReservation.id, managementCredential,
    }, { actor: RESERVATION_ACTOR })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.queries.execute('booking.reservation.getOwned', {
      reservationId: ownedReservation.id,
    }, { actor: owner })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: ownedReservation.id, managementCredential, primaryGuestName: 'Must Stay Redacted',
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(runtime.commands.execute('booking.reservation.updateManagedDetails', {
      reservationId: ownedReservation.id, primaryGuestName: 'Must Stay Redacted',
    }, { actor: owner, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET booker_name = $2 WHERE id = $1',
      [ownedReservation.id, 'Must Stay Redacted'],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(runtime.database.pool.query(
      'UPDATE booking_reservation_reservations SET pii_anonymized_at = NULL, booker_name = $2 WHERE id = $1',
      [ownedReservation.id, 'Must Stay Redacted'],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(enqueueAndRunRetentionJob(`booking-retention-repeat:${randomUUID()}`))
      .resolves.toMatchObject({ failed: 0 });
    const repeatedAudits = await runtime.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'booking.reservation.pii-anonymized' AND resource_id = ANY($1::text[])
    `, [reservationIds]);
    expect(Number(repeatedAudits.rows[0]?.count)).toBe(102);
  }, 180_000);

  it('leaves before-cutoff, future, and invalid-timezone Reservations unchanged regardless of payment status', async () => {
    const { reservation: template } = await createReservation('retention-ineligible-template');
    const databaseNow = await runtime.database.pool.query<{ now: Date }>('SELECT now() AS now');
    const today = propertyLocalDate(databaseNow.rows[0]!.now);
    const eligibleCheckout = addDays(today, -2);
    const ids = [template.id, ...await cloneReservations(template.id, 3)];
    const scenarios = [
      { id: ids[0]!, status: 'confirmed', checkout: eligibleCheckout, zone: PROPERTY_TIME_ZONE },
      { id: ids[1]!, status: 'confirmed', checkout: today, zone: PROPERTY_TIME_ZONE },
      { id: ids[2]!, status: 'confirmed', checkout: addDays(today, 1), zone: PROPERTY_TIME_ZONE },
      { id: ids[3]!, status: 'pending_payment', checkout: eligibleCheckout, zone: PROPERTY_TIME_ZONE },
    ];
    for (const scenario of scenarios) {
      await runtime.database.pool.query(`
        UPDATE booking_reservation_reservations
        SET status = $2, check_out_local_date = $3, check_in_local_date = $4,
            cancellation_policy = jsonb_set(cancellation_policy, '{propertyTimeZone}', to_jsonb($5::text))
        WHERE id = $1
      `, [scenario.id, scenario.status, scenario.checkout, addDays(scenario.checkout, -2), scenario.zone]);
    }
    const invalidTimezoneId = randomUUID();
    await runtime.database.pool.query(`
      INSERT INTO booking_reservation_reservations (
        id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
        booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes,
        status, payment_expires_at, currency, total_minor, nightly_prices, cancellation_policy,
        quote_fingerprint, created_at, access_generation, access_grant_nonce, access_grant_expires_at,
        access_grant_used_at, management_token_hash, owner_account_id, pii_anonymized_at
      )
      SELECT $2, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
        booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes, 'confirmed',
        payment_expires_at, currency, total_minor, nightly_prices,
        jsonb_set(cancellation_policy, '{propertyTimeZone}', to_jsonb('Invalid/Time_Zone'::text)),
        quote_fingerprint, created_at, 0, NULL, NULL, NULL, NULL, NULL, NULL
      FROM booking_reservation_reservations WHERE id = $1
    `, [template.id, invalidTimezoneId]);
    await runtime.database.pool.query(`
      UPDATE booking_reservation_reservations SET status = 'confirmed', check_in_local_date = $2,
        check_out_local_date = $3 WHERE id = $1
    `, [invalidTimezoneId, addDays(eligibleCheckout, -2), eligibleCheckout]);

    const testedIds = [...ids, invalidTimezoneId];
    const before = await runtime.database.pool.query<{
      id: string; status: string; check_in_local_date: string; check_out_local_date: string;
      booker_name: string; pii_anonymized_at: Date | null;
    }>(`
      SELECT id, status, check_in_local_date::text, check_out_local_date::text, booker_name, pii_anonymized_at
      FROM booking_reservation_reservations
      WHERE id = ANY($1::uuid[])
    `, [testedIds]);
    await expect(enqueueAndRunRetentionJob(`booking-retention-ineligible:${randomUUID()}`))
      .resolves.toMatchObject({ failed: 0 });

    const after = await runtime.database.pool.query<{
      id: string; status: string; check_in_local_date: string; check_out_local_date: string;
      booker_name: string | null; pii_anonymized_at: Date | null;
    }>(`
      SELECT id, status, check_in_local_date::text, check_out_local_date::text, booker_name, pii_anonymized_at
      FROM booking_reservation_reservations
      WHERE id = ANY($1::uuid[])
    `, [testedIds]);
    expect(after.rows).toHaveLength(testedIds.length);
    for (const row of after.rows) {
      const original = before.rows.find(candidate => candidate.id === row.id)!;
      if (row.id === ids[0] || row.id === ids[3]) {
        expect(row).toMatchObject({
          status: original.status,
          check_in_local_date: original.check_in_local_date,
          check_out_local_date: original.check_out_local_date,
          booker_name: null,
          pii_anonymized_at: expect.any(Date),
        });
      } else {
        expect(row).toEqual(original);
      }
    }
  }, 180_000);

  it('serializes redaction against competing claim, Grant redemption, and detail updates', async () => {
    const { reservation: claimRace } = await createReservation('retention-race-claim');
    const { reservation: redeemRace } = await createReservation('retention-race-redeem');
    const { reservation: managedUpdateRace } = await createReservation('retention-race-managed-update');
    const { reservation: ownerUpdateRace } = await createReservation('retention-race-owner-update');
    const reservations = [claimRace, redeemRace, managedUpdateRace, ownerUpdateRace];
    for (const reservation of reservations) await makeRetentionEligible(reservation.id);

    const claimGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: claimRace.id, ttlMs: 15 * 60_000,
    }));
    const claimCredential = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: claimGrant.grantToken,
    }));
    const claimant = signedInAccountActor(randomUUID(), 'customer');

    const redemptionGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: redeemRace.id, ttlMs: 15 * 60_000,
    }));
    const updateGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: managedUpdateRace.id, ttlMs: 15 * 60_000,
    }));
    const updateCredential = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: updateGrant.grantToken,
    }));
    const ownerGrant = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
      reservationId: ownerUpdateRace.id, ttlMs: 15 * 60_000,
    }));
    const ownerCredential = await runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: ownerGrant.grantToken,
    }));
    const owner = signedInAccountActor(randomUUID(), 'customer');
    await runtime.commands.execute('booking.reservation.claim', {
      reservationId: ownerUpdateRace.id, managementCredential: ownerCredential.managementCredential,
    }, { actor: owner, idempotencyKey: randomUUID() });

    const worker = await enqueueRetentionJob(`booking-retention-races:${randomUUID()}`);
    const outcomes = await Promise.allSettled([
      worker.runJobs(),
      runtime.commands.execute('booking.reservation.claim', {
        reservationId: claimRace.id, managementCredential: claimCredential.managementCredential,
      }, { actor: claimant, idempotencyKey: randomUUID() }),
      runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, { grantToken: redemptionGrant.grantToken })),
      runtime.commands.execute('booking.reservation.updateManagedDetails', {
        reservationId: managedUpdateRace.id,
        managementCredential: updateCredential.managementCredential,
        primaryGuestName: 'Racing Management Guest',
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() }),
      runtime.commands.execute('booking.reservation.updateManagedDetails', {
        reservationId: ownerUpdateRace.id,
        primaryGuestName: 'Racing Owner Guest',
      }, { actor: owner, idempotencyKey: randomUUID() }),
    ]);
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { processed: 1, failed: 0 } });
    for (const result of outcomes.slice(1)) {
      if (result.status === 'rejected') {
        expect(['UNAUTHENTICATED', 'NOT_FOUND', 'CONFLICT']).toContain((result.reason as { code?: string }).code);
      }
    }
    // The shared test database may contain an older retention continuation.
    // Finish the current run before checking this race's terminal state; this
    // does not weaken the race assertion above, which has already overlapped
    // the competing commands with the first claimed retention batch.
    expect((await drainRetentionJobs(worker)).failed).toBe(0);

    const finalRows = await runtime.database.pool.query<{
      id: string; booker_name: string | null; primary_guest_name: string | null;
      owner_account_id: string | null; pii_anonymized_at: Date | null; access_generation: number;
      access_grant_nonce: string | null; access_grant_expires_at: Date | null;
      access_grant_used_at: Date | null; management_token_hash: string | null;
      checkout_credential_key_id: string | null; checkout_credential_nonce: string | null;
      checkout_credential_hash: string | null; checkout_credential_expires_at: Date | null;
    }>(`
      SELECT id, booker_name, primary_guest_name, owner_account_id, pii_anonymized_at,
             access_generation, access_grant_nonce, access_grant_expires_at,
             access_grant_used_at, management_token_hash, checkout_credential_key_id,
             checkout_credential_nonce, checkout_credential_hash, checkout_credential_expires_at
      FROM booking_reservation_reservations WHERE id = ANY($1::uuid[])
    `, [reservations.map(reservation => reservation.id)]);
    expect(finalRows.rows).toHaveLength(reservations.length);
    expect(finalRows.rows.every(row => row.booker_name === null && row.primary_guest_name === null
      && row.owner_account_id === null && row.pii_anonymized_at instanceof Date
      && row.access_generation === 0 && row.access_grant_nonce === null && row.access_grant_expires_at === null
      && row.access_grant_used_at === null && row.management_token_hash === null
      && row.checkout_credential_key_id === null && row.checkout_credential_nonce === null
      && row.checkout_credential_hash === null && row.checkout_credential_expires_at === null)).toBe(true);
  }, 180_000);

  it('self-cancels before the frozen deadline through management access, refunds the winner, and redacts the credential', async () => {
    const { roomType, reservation } = await createReservation('cancel-self-management');
    const winner = await confirmReservationForCancellation(reservation.id);
    const credential = await managementCredentialFor(reservation.id);
    const result = await runtime.commands.execute<{
      reservationId: string; cancelled: true; refund: { id: string; amountMinor: number; currency: string } | null;
    }>('booking.reservation.cancelSelf', { reservationId: reservation.id, managementCredential: credential }, {
      actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
    });
    expect(result).toEqual({ reservationId: reservation.id, cancelled: true, refund: {
      id: expect.any(String), amountMinor: 24_690, currency: 'USD',
    } });
    expect(await reservedCounts(roomType.id)).toEqual([0, 0]);
    const state = await runtime.database.pool.query<{ status: string; attempt_status: string; refund_reason: string }>(`
      SELECT r.status, a.status AS attempt_status, f.reason AS refund_reason
      FROM booking_reservation_reservations r
      JOIN booking_reservation_payment_attempts a ON a.id = $2
      JOIN booking_reservation_refunds f ON f.reservation_id = r.id
      WHERE r.id = $1
    `, [reservation.id, winner.id]);
    expect(state.rows).toEqual([{ status: 'cancelled', attempt_status: 'succeeded', refund_reason: 'reservation_cancellation' }]);
    const audit = await runtime.database.pool.query<{ payload: string }>(`
      SELECT payload::text AS payload FROM platform_audit_log
      WHERE action = 'booking.reservation.self-cancelled' AND resource_id = $1
    `, [reservation.id]);
    expect(audit.rows).toEqual([{ payload: expect.not.stringContaining(credential) }]);
    await clearRefundJobs(reservation.id);

    const owned = await createReservation('cancel-self-owner');
    const ownerCredential = await managementCredentialFor(owned.reservation.id);
    const owner = signedInAccountActor();
    await runtime.commands.execute('booking.reservation.claim', {
      reservationId: owned.reservation.id, managementCredential: ownerCredential,
    }, { actor: owner, idempotencyKey: randomUUID() });
    await confirmReservationForCancellation(owned.reservation.id);
    await expect(runtime.commands.execute('booking.reservation.cancelSelf', { reservationId: owned.reservation.id }, {
      actor: owner, idempotencyKey: randomUUID(),
    })).resolves.toMatchObject({ reservationId: owned.reservation.id, cancelled: true, refund: { amountMinor: 24_690 } });
    expect(await reservedCounts(owned.roomType.id)).toEqual([0, 0]);
    await clearRefundJobs(owned.reservation.id);
  }, 120_000);

  it('lets an operator record zero, partial, and full refund decisions without provider I/O', async () => {
    for (const [suffix, amount] of [['zero', 0], ['partial', 12_345], ['full', 24_690]] as const) {
      const { roomType, reservation } = await createReservation(`cancel-operator-${suffix}`);
      await confirmReservationForCancellation(reservation.id);
      const result = await runtime.commands.execute<{ cancelled: true; refund: { amountMinor: number } | null }>(
        'booking.reservation.cancelByOperator', { reservationId: reservation.id, refundAmountMinor: amount, reason: `operator ${suffix}` },
        { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() },
      );
      expect(result).toMatchObject({ cancelled: true, refund: amount === 0 ? null : { amountMinor: amount } });
      expect(await reservedCounts(roomType.id)).toEqual([0, 0]);
      const audit = await runtime.database.pool.query<{ payload: { reason: string; refundAmountMinor: number } }>(`
        SELECT payload FROM platform_audit_log WHERE action = 'booking.reservation.operator-cancelled' AND resource_id = $1
      `, [reservation.id]);
      expect(audit.rows).toEqual([{ payload: { reason: `operator ${suffix}`, refundAmountMinor: amount } }]);
      await clearRefundJobs(reservation.id);
    }
  }, 120_000);

  it('rejects unauthorized, late, invalid, and concurrent cancellations without duplicate release or refund evidence', async () => {
    const unauthorized = await createReservation('cancel-reject-unauthorized');
    await expect(runtime.commands.execute('booking.reservation.cancelSelf', { reservationId: unauthorized.reservation.id }, {
      actor: RESERVATION_ACTOR, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await reservedCounts(unauthorized.roomType.id)).toEqual([1, 1]);

    const ownedByAnotherAccount = await createReservation('cancel-reject-nonowner');
    const ownerCredential = await managementCredentialFor(ownedByAnotherAccount.reservation.id);
    const owner = signedInAccountActor();
    await runtime.commands.execute('booking.reservation.claim', {
      reservationId: ownedByAnotherAccount.reservation.id, managementCredential: ownerCredential,
    }, { actor: owner, idempotencyKey: randomUUID() });
    await expect(runtime.commands.execute('booking.reservation.cancelSelf', { reservationId: ownedByAnotherAccount.reservation.id }, {
      actor: signedInAccountActor(), idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await reservedCounts(ownedByAnotherAccount.roomType.id)).toEqual([1, 1]);

    const credentialSource = await createReservation('cancel-reject-cross-credential-source');
    const crossCredential = await managementCredentialFor(credentialSource.reservation.id);
    const credentialTarget = await createReservation('cancel-reject-cross-credential-target');
    for (const managementCredential of [crossCredential, 'brm1.2.invalid']) {
      await expect(runtime.commands.execute('booking.reservation.cancelSelf', {
        reservationId: credentialTarget.reservation.id, managementCredential,
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await reservedCounts(credentialTarget.roomType.id)).toEqual([1, 1]);
    const rejectedAuthState = await runtime.database.pool.query<{
      id: string; status: string; refunds: string; audits: string;
    }>(`
      SELECT r.id::text AS id, r.status, count(DISTINCT f.id)::text AS refunds, count(DISTINCT a.id)::text AS audits
      FROM booking_reservation_reservations r
      LEFT JOIN booking_reservation_refunds f ON f.reservation_id = r.id
      LEFT JOIN platform_audit_log a ON a.resource_id = r.id::text
        AND a.action = 'booking.reservation.self-cancelled'
      WHERE r.id = ANY($1::uuid[]) GROUP BY r.id, r.status ORDER BY r.id
    `, [[unauthorized.reservation.id, ownedByAnotherAccount.reservation.id, credentialTarget.reservation.id]]);
    expect(rejectedAuthState.rows).toHaveLength(3);
    expect(rejectedAuthState.rows.every(row => row.status === 'pending_payment' && row.refunds === '0' && row.audits === '0')).toBe(true);

    const late = await createReservation('cancel-reject-late');
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET cancellation_policy = jsonb_set(cancellation_policy, '{freeCancellationHoursBeforeCheckIn}', '8760'::jsonb)
      WHERE id = $1`, [late.reservation.id]);
    const lateCredential = await managementCredentialFor(late.reservation.id);
    await expect(runtime.commands.execute('booking.reservation.cancelSelf', {
      reservationId: late.reservation.id, managementCredential: lateCredential,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await reservedCounts(late.roomType.id)).toEqual([1, 1]);

    const invalid = await createReservation('cancel-reject-invalid');
    await confirmReservationForCancellation(invalid.reservation.id);
    const invalidKey = randomUUID();
    await expect(runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: invalid.reservation.id, refundAmountMinor: 24_691, reason: 'too much',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: invalidKey })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: invalid.reservation.id, refundAmountMinor: 0, reason: ' ',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: invalid.reservation.id, refundAmountMinor: 0, reason: 'no partial mutation', roomCount: 2,
    } as never, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations SET status = 'cancelled'
      WHERE id = $1`, [invalid.reservation.id]);
    await expect(runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: invalid.reservation.id, refundAmountMinor: 0, reason: 'terminal state',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    const invalidState = await runtime.database.pool.query<{ status: string; room_count: number; refunds: string }>(`
      SELECT r.status, r.room_count, count(f.id)::text AS refunds FROM booking_reservation_reservations r
      LEFT JOIN booking_reservation_refunds f ON f.reservation_id = r.id WHERE r.id = $1 GROUP BY r.status, r.room_count
    `, [invalid.reservation.id]);
    expect(invalidState.rows).toEqual([{ status: 'cancelled', room_count: 1, refunds: '0' }]);
    expect(await reservedCounts(invalid.roomType.id)).toEqual([1, 1]);

    const race = await createReservation('cancel-concurrent');
    await confirmReservationForCancellation(race.reservation.id);
    const results = await Promise.allSettled([
      runtime.commands.execute('booking.reservation.cancelByOperator', {
        reservationId: race.reservation.id, refundAmountMinor: 24_690, reason: 'first cancellation',
      }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() }),
      runtime.commands.execute('booking.reservation.cancelByOperator', {
        reservationId: race.reservation.id, refundAmountMinor: 24_690, reason: 'second cancellation',
      }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason.code)).toEqual(['CONFLICT']);
    expect(await reservedCounts(race.roomType.id)).toEqual([0, 0]);
    const refunds = await runtime.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_reservation_refunds WHERE reservation_id = $1', [race.reservation.id],
    );
    expect(refunds.rows).toEqual([{ count: '1' }]);
    await clearRefundJobs(race.reservation.id);
  }, 120_000);

  it('uses a post-lock database wall clock so a self-cancellation that waits through the exact cutoff leaves no drift', async () => {
    const { roomType, reservation } = await createReservation('cancel-self-wall-clock-cutoff');
    const credential = await managementCredentialFor(reservation.id);
    // Arrange the next minute boundary while keeping the actual row-lock wait comfortably below PostgreSQL's statement timeout.
    const initialClock = await runtime.database.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const millisecondsIntoMinute = initialClock.rows[0]!.now.getTime() % 60_000;
    const millisecondsUntilFortySeconds = (40_000 - millisecondsIntoMinute + 60_000) % 60_000;
    if (millisecondsUntilFortySeconds > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, millisecondsUntilFortySeconds));
    }
    const clock = await runtime.database.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const deadline = new Date((Math.floor(clock.rows[0]!.now.getTime() / 60_000) + 1) * 60_000);
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET cancellation_policy = jsonb_build_object(
        'freeCancellationHoursBeforeCheckIn', 0,
        'propertyTimeZone', 'UTC',
        'checkInTime', $2::text
      ), check_in_local_date = $3::date
      WHERE id = $1`, [reservation.id, deadline.toISOString().slice(11, 16), deadline.toISOString().slice(0, 10)]);
    const releaseLock = await holdReservationLifecycleLock(reservation.id);
    expect(Date.now()).toBeLessThan(deadline.getTime());
    const cancellation = runtime.commands.execute('booking.reservation.cancelSelf', {
      reservationId: reservation.id, managementCredential: credential,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() });
    await waitForDatabaseLockWait();
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 25));
    await releaseLock();
    await expect(cancellation).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    const unchanged = await runtime.database.pool.query<{ status: string; refunds: string; audits: string }>(`
      SELECT r.status, count(DISTINCT f.id)::text AS refunds, count(DISTINCT a.id)::text AS audits
      FROM booking_reservation_reservations r
      LEFT JOIN booking_reservation_refunds f ON f.reservation_id = r.id
      LEFT JOIN platform_audit_log a ON a.resource_id = r.id::text AND a.action = 'booking.reservation.self-cancelled'
      WHERE r.id = $1 GROUP BY r.status
    `, [reservation.id]);
    expect(unchanged.rows).toEqual([{ status: 'pending_payment', refunds: '0', audits: '0' }]);
  }, 120_000);

  it('rolls cancellation back when release fails, but retains cancelled and released state if its asynchronous refund later fails', async () => {
    const rollback = await createReservation('cancel-release-failure');
    await confirmReservationForCancellation(rollback.reservation.id);
    failAfterRoomNightRelease = true;
    try {
      await expect(runtime.commands.execute('booking.reservation.cancelByOperator', {
        reservationId: rollback.reservation.id, refundAmountMinor: 24_690, reason: 'release fails',
      }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow('forced post-release failure');
    } finally {
      failAfterRoomNightRelease = false;
    }
    expect(await reservedCounts(rollback.roomType.id)).toEqual([1, 1]);
    const rollbackState = await runtime.database.pool.query<{ status: string; refunds: string }>(`
      SELECT r.status, count(f.id)::text AS refunds FROM booking_reservation_reservations r
      LEFT JOIN booking_reservation_refunds f ON f.reservation_id = r.id WHERE r.id = $1 GROUP BY r.status
    `, [rollback.reservation.id]);
    expect(rollbackState.rows).toEqual([{ status: 'confirmed', refunds: '0' }]);

    const failed = await createReservation('cancel-refund-failure');
    await confirmReservationForCancellation(failed.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: failed.reservation.id, refundAmountMinor: 24_690, reason: 'refund later fails',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await runtime.database.pool.query(`UPDATE platform_jobs SET attempts = 4 WHERE type = 'booking.reservation.process-refund'
      AND payload->>'refundId' IN (SELECT id::text FROM booking_reservation_refunds WHERE reservation_id = $1)`, [failed.reservation.id]);
    refundError = new Error('refund provider unavailable');
    try {
      const worker = new Worker(runtime, { workerId: `cancel-refund-failure-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      let targetFailed = false;
      for (let round = 0; round < 100; round += 1) {
        await worker.runJobs();
        const status = await runtime.database.pool.query<{ status: string }>(`
          SELECT status FROM booking_reservation_refunds WHERE reservation_id = $1
        `, [failed.reservation.id]);
        if (status.rows[0]?.status === 'failed') { targetFailed = true; break; }
      }
      expect(targetFailed).toBe(true);
    } finally {
      refundError = undefined;
    }
    expect(await reservedCounts(failed.roomType.id)).toEqual([0, 0]);
    const failedState = await runtime.database.pool.query<{ status: string; refund_status: string }>(`
      SELECT r.status, f.status AS refund_status FROM booking_reservation_reservations r
      JOIN booking_reservation_refunds f ON f.reservation_id = r.id WHERE r.id = $1
    `, [failed.reservation.id]);
    expect(failedState.rows).toEqual([{ status: 'cancelled', refund_status: 'failed' }]);
  }, 120_000);

  it('materializes each current Reservation event once through Base notifications, with a redeem-once Grant and masked operator evidence', async () => {
    const expiring = await createReservation('notification-payment-expiring');
    const expiringAttempt = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: expiring.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(expiring.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(expiring.reservation.id);
    const providerExpiry = new Date(new Date(expiring.reservation.paymentExpiresAt).getTime() - 30_000).toISOString();
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: expiringAttempt.attempt.reference, providerRef: 'notification:payment-expiring',
      instructions: [{ label: 'Bank code', value: '123456' }], expiresAt: providerExpiry,
    });

    const confirmed = await createReservation('notification-confirmed');
    const confirmedAttempt = await confirmReservationForCancellation(confirmed.reservation.id);
    const cancelled = await createReservation('notification-cancelled');
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: cancelled.reservation.id, refundAmountMinor: 0, reason: 'notification fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });

    // Retention tests earlier in this shared database can leave historical
    // events whose Booker PII has subsequently been anonymized.  Their
    // terminal mapping failures are correct work outcomes, not a failure of
    // these three current event materializations; assert those exact links
    // below instead of treating a global worker counter as this fixture's API.
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ relayed: expect.any(Number) });
    const reservationIds = [expiring.reservation.id, confirmed.reservation.id, cancelled.reservation.id];
    const links = await runtime.database.pool.query<{
      reservation_id: string; event_id: string; kind: string; template_id: string; reference: string; mapping_status: string;
    }>(`SELECT reservation_id, event_id, kind, template_id, reference, mapping_status
      FROM booking_reservation_notification_links WHERE reservation_id = ANY($1::uuid[]) ORDER BY kind`, [reservationIds]);
    expect(links.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ reservation_id: expiring.reservation.id, kind: 'payment-expiring', template_id: 'booking.reservation.payment-expiring', mapping_status: 'requested' }),
      expect.objectContaining({ reservation_id: confirmed.reservation.id, kind: 'confirmed', template_id: 'booking.reservation.confirmed', mapping_status: 'requested' }),
      expect.objectContaining({ reservation_id: cancelled.reservation.id, kind: 'cancelled', template_id: 'booking.reservation.cancelled', mapping_status: 'requested' }),
    ]));
    expect(links.rows).toHaveLength(3);
    const requests = await runtime.database.pool.query<{
      reference: string; template_id: string; recipient_email: string; variables: { accessGrant: string; accessGrantExpiresAt: string };
    }>(`SELECT reference, template_id, recipient_email, variables
      FROM platform_notifications WHERE reference = ANY($1::text[]) ORDER BY template_id`, [links.rows.map(link => link.reference)]);
    expect(requests.rows).toHaveLength(3);
    expect(requests.rows.map(row => row.template_id).sort()).toEqual([
      'booking.reservation.cancelled', 'booking.reservation.confirmed', 'booking.reservation.payment-expiring',
    ]);
    expect(requests.rows.every(row => row.recipient_email === 'private.booker@example.test')).toBe(true);

    const expiringLink = links.rows.find(link => link.reservation_id === expiring.reservation.id)!;
    const expiringRequest = requests.rows.find(row => row.reference === expiringLink.reference)!;
    expect(expiringRequest.variables.accessGrant).toEqual(expect.any(String));
    expect(JSON.stringify(expiringRequest)).not.toMatch(/(?:managementCredential|managementToken|brm1\.)/i);
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: expiringRequest.variables.accessGrant,
    }))).resolves.toMatchObject({ managementCredential: expect.stringMatching(/^brm1\./) });
    await expect(runtime.database.transaction(tx => reservationAccess.redeemGrant(tx, {
      grantToken: expiringRequest.variables.accessGrant,
    }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // A replayed event materialization converges on its existing link/reference
    // instead of issuing another Grant or creating another Base request.
    await runtime.commands.execute('booking.reservation.materializeNotification', {
      eventId: expiringLink.event_id, kind: 'payment-expiring', reservationId: expiring.reservation.id,
      paymentAttemptId: expiringAttempt.attempt.id, expiresAt: providerExpiry,
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    const replayCounts = await runtime.database.pool.query<{ links: string; requests: string }>(`
      SELECT
        (SELECT count(*)::text FROM booking_reservation_notification_links WHERE reference = $1) AS links,
        (SELECT count(*)::text FROM platform_notifications WHERE reference = $1) AS requests
    `, [expiringLink.reference]);
    expect(replayCounts.rows).toEqual([{ links: '1', requests: '1' }]);

    // The Base delivery record is the source of truth. Simulate a terminal
    // provider result and verify the Booking operator projection masks it.
    await runtime.database.pool.query(`UPDATE platform_notification_deliveries d
      SET status = 'failed', last_error = 'mail rejected private.booker@example.test'
      FROM platform_notifications n WHERE n.id = d.notification_id AND n.reference = $1`, [expiringLink.reference]);
    const evidence = await runtime.queries.execute<any>('booking.reservation.listNotifications', {
      reservationId: expiring.reservation.id, limit: 20, offset: 0,
    }, { actor: actor(['booking-reservation:notification-read']) });
    expect(evidence.items).toEqual([expect.objectContaining({
      reference: expiringLink.reference,
      deliveries: [expect.objectContaining({ status: 'failed', recipientMasked: 'p***@example.test' })],
    })]);
    expect(JSON.stringify(evidence)).not.toContain('private.booker@example.test');
    expect(JSON.stringify(evidence)).not.toContain('lastError');
    expect(JSON.stringify(evidence)).not.toContain('mail rejected');
    const unchanged = await runtime.database.pool.query<{ status: string; reserved: string }>(`
      SELECT r.status, count(*)::text AS reserved
      FROM booking_reservation_reservations r
      JOIN booking_availability_room_nights n ON n.room_type_id = r.room_type_id
      WHERE r.id = $1 GROUP BY r.status`, [expiring.reservation.id]);
    expect(unchanged.rows).toEqual([{ status: 'pending_payment', reserved: '2' }]);
    expect(confirmedAttempt.id).toEqual(expect.any(String));
  }, 120_000);

  it('alerts once for a late Provider initiation result and keeps its Attempt/refund correlation on replay', async () => {
    const fixture = await createReservation('late-initiation-alert');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'late initiation fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    const result = {
      attemptId: started.attempt.id, provider: bookingPaymentProviderId,
      result: { status: 'confirmed', providerRef: `late-initiation:${started.attempt.id}` },
    };
    await runtime.commands.execute('booking.reservation.recordPaymentResult', result,
      { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await runtime.commands.execute('booking.reservation.recordPaymentResult', result,
      { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await drainBookingNotificationWork();
    const evidence = await runtime.database.pool.query<{
      event_id: string; payment_attempt_id: string; refund_id: string; mapping_status: string;
      recipient_email: string; variables: Record<string, unknown>;
    }>(`SELECT l.event_id, l.payment_attempt_id, l.refund_id, l.mapping_status,
        n.recipient_email, n.variables
      FROM booking_reservation_notification_links l
      JOIN platform_notifications n ON n.reference = l.reference
      WHERE l.reservation_id = $1 AND l.kind = 'late-payment'`, [fixture.reservation.id]);
    expect(evidence.rows).toEqual([expect.objectContaining({
      event_id: started.attempt.id, payment_attempt_id: started.attempt.id,
      refund_id: expect.any(String), mapping_status: 'requested', recipient_email: 'booking-alerts@example.test',
    })]);
    expect(evidence.rows[0]!.variables).toEqual({
      reservationId: fixture.reservation.id, paymentAttemptId: started.attempt.id,
      refundId: evidence.rows[0]!.refund_id,
    });
    const delivery = await runtime.database.pool.query<{ status: string }>(`
      SELECT d.status FROM platform_notification_deliveries d
      JOIN platform_notifications n ON n.id = d.notification_id
      WHERE n.reference = $1`,
    [`booking-reservation:${started.attempt.id}:booking.reservation.late-payment`]);
    expect(delivery.rows).toEqual([{ status: 'skipped' }]);
    const operatorEvidence = await runtime.queries.execute<any>('booking.reservation.listNotifications', {
      reservationId: fixture.reservation.id, limit: 20, offset: 0,
    }, { actor: actor(['booking-reservation:notification-read']) });
    expect(operatorEvidence.items.find((item: { kind: string }) => item.kind === 'late-payment')?.deliveries)
      .toEqual([expect.objectContaining({ status: 'skipped' })]);
    expect(await reservedCounts(fixture.roomType.id)).toEqual([0, 0]);
    await runtime.database.pool.query(`UPDATE platform_notification_deliveries d
      SET status = 'failed' FROM platform_notifications n
      WHERE n.id = d.notification_id AND n.reference LIKE $1`,
    [`booking-reservation:${started.attempt.id}:booking.reservation.late-payment`]);
    const corrected = await createAlertRepairRuntime('corrected-alerts@example.test');
    try {
      await corrected.commands.execute('booking.reservation.materializeNotification', {
        eventId: started.attempt.id, kind: 'late-payment', reservationId: fixture.reservation.id,
        paymentAttemptId: started.attempt.id, refundId: evidence.rows[0]!.refund_id,
      }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    } finally {
      await corrected.close();
    }
    const immutable = await runtime.database.pool.query<{ recipient_email: string; count: string }>(`
      SELECT n.recipient_email, count(*)::text AS count FROM platform_notifications n
      WHERE n.reference = $1 GROUP BY n.recipient_email`,
    [`booking-reservation:${started.attempt.id}:booking.reservation.late-payment`]);
    expect(immutable.rows).toEqual([{ recipient_email: 'booking-alerts@example.test', count: '1' }]);
    const auditSql = `SELECT id, action, resource_id, payload FROM platform_audit_log
      WHERE action = 'booking.reservation.payment-result-recorded' AND resource_id = $1 ORDER BY id`;
    const auditBeforeRetention = await runtime.database.pool.query(auditSql, [started.attempt.id]);
    expect(auditBeforeRetention.rows.length).toBeGreaterThan(0);
    const databaseNow = await runtime.database.pool.query<{ now: Date }>('SELECT now() AS now');
    const checkout = addDays(propertyLocalDate(databaseNow.rows[0]!.now), -2);
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET check_in_local_date = $2, check_out_local_date = $3 WHERE id = $1`,
    [fixture.reservation.id, addDays(checkout, -2), checkout]);
    await expect(enqueueAndRunRetentionJob(`late-alert-retention:${randomUUID()}`))
      .resolves.toMatchObject({ failed: 0 });
    const retained = await runtime.database.pool.query<{
      booker_email: string | null; primary_guest_name: string | null;
      payment_attempt_id: string; refund_id: string;
    }>(`SELECT r.booker_email, r.primary_guest_name, l.payment_attempt_id, l.refund_id
      FROM booking_reservation_reservations r
      JOIN booking_reservation_notification_links l ON l.reservation_id = r.id
      WHERE r.id = $1 AND l.kind = 'late-payment'`, [fixture.reservation.id]);
    expect(retained.rows).toEqual([{
      booker_email: null, primary_guest_name: null,
      payment_attempt_id: started.attempt.id, refund_id: evidence.rows[0]!.refund_id,
    }]);
    const auditAfterRetention = await runtime.database.pool.query(auditSql, [started.attempt.id]);
    expect(auditAfterRetention.rows).toEqual(auditBeforeRetention.rows);
  }, 120_000);

  it('reconciles a historical Late Attempt at a recorded cutoff without another payment or refund', async () => {
    const fixture = await createReservation('historical-late-alert');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'historical late fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: started.attempt.reference,
      providerRef: `historical-late:${started.attempt.id}`,
    });
    await runtime.database.pool.query(`DELETE FROM platform_outbox
      WHERE event_name = 'booking.reservation.latePayment.v1' AND payload->>'paymentAttemptId' = $1`,
    [started.attempt.id]);
    const refundBefore = await runtime.database.pool.query<{ id: string; generation: number }>(
      'SELECT id, generation FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [started.attempt.id]);
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    let afterAttemptId: string | undefined;
    let found = false;
    for (let page = 0; page < 20; page++) {
      const result = await runtime.commands.execute<{
        scanned: number; enqueued: number; missingRefunds: number; nextAfterAttemptId: string | null;
      }>('booking.reservation.reconcileLatePaymentNotifications', {
        cutoff, limit: 100, ...(afterAttemptId ? { afterAttemptId } : {}),
      }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
      found ||= result.enqueued > 0;
      if (!result.nextAfterAttemptId) break;
      afterAttemptId = result.nextAfterAttemptId;
    }
    expect(found).toBe(true);
    await drainBookingNotificationWork();
    const links = await runtime.database.pool.query<{ refund_id: string; mapping_status: string }>(`
      SELECT refund_id, mapping_status FROM booking_reservation_notification_links
      WHERE payment_attempt_id = $1 AND kind = 'late-payment'`, [started.attempt.id]);
    expect(links.rows).toEqual([{ refund_id: refundBefore.rows[0]!.id, mapping_status: 'requested' }]);
    const refundAfter = await runtime.database.pool.query<{ id: string; generation: number }>(
      'SELECT id, generation FROM booking_reservation_refunds WHERE payment_attempt_id = $1', [started.attempt.id]);
    expect(refundAfter.rows).toEqual(refundBefore.rows);
  }, 120_000);

  it('accepts and runs the real hourly Late notification reconciliation occurrence', async () => {
    const scheduled = await runtime.recurring.ensureScheduled(new Date());
    expect(scheduled.failed).toBe(0);
    const occurrence = await runtime.database.pool.query<{
      id: string; payload: unknown; payload_version: number; status: string;
    }>(`SELECT id, payload, payload_version, status FROM platform_jobs
      WHERE type = 'booking.reservation.reconcile-late-notifications'
      ORDER BY created_at DESC LIMIT 1`);
    expect(occurrence.rows).toHaveLength(1);
    expect(runtime.jobRegistry.decode('booking.reservation.reconcile-late-notifications',
      occurrence.rows[0]!.payload, occurrence.rows[0]!.payload_version)).toMatchObject({
      bucket: expect.any(Number), scheduledFor: expect.any(String),
    });
    const worker = new Worker(runtime, { workerId: `late-reconcile-schedule-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    for (let round = 0; round < 100; round++) {
      await worker.runJobs();
      const state = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM platform_jobs WHERE id = $1', [occurrence.rows[0]!.id]);
      if (state.rows[0]?.status === 'completed') break;
    }
    const completed = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM platform_jobs WHERE id = $1', [occurrence.rows[0]!.id]);
    expect(completed.rows).toEqual([{ status: 'completed' }]);
  }, 120_000);

  it('keeps malformed Late event evidence without blocking the corrected Attempt alert', async () => {
    const fixture = await createReservation('malformed-late-alert');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'malformed Late event fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: started.attempt.reference,
      providerRef: `malformed-late:${started.attempt.id}`,
    });
    const outbox = await runtime.database.pool.query<{ id: string }>(`
      SELECT id FROM platform_outbox WHERE event_name = 'booking.reservation.latePayment.v1'
        AND payload->>'paymentAttemptId' = $1`, [started.attempt.id]);
    expect(outbox.rows).toHaveLength(1);
    const wrongRefundId = randomUUID();
    await runtime.database.pool.query(`UPDATE platform_outbox
      SET payload = jsonb_set(payload, '{refundId}', to_jsonb($2::text)) WHERE id = $1`,
    [outbox.rows[0]!.id, wrongRefundId]);
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: expect.any(Number) });
    const failed = await runtime.database.pool.query<{ event_id: string; refund_id: string; mapping_failure_code: string }>(`
      SELECT event_id, refund_id, mapping_failure_code FROM booking_reservation_notification_links
      WHERE payment_attempt_id = $1 AND kind = 'late-payment'`, [started.attempt.id]);
    expect(failed.rows).toEqual([{
      event_id: outbox.rows[0]!.id, refund_id: wrongRefundId, mapping_failure_code: 'late_evidence_invalid',
    }]);
    await runtime.commands.execute('booking.reservation.reconcileLatePaymentNotifications', {
      cutoff: new Date(Date.now() + 60_000).toISOString(), limit: 100,
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await drainBookingNotificationWork();
    const links = await runtime.database.pool.query<{ event_id: string; mapping_status: string; refund_id: string }>(`
      SELECT event_id, mapping_status, refund_id FROM booking_reservation_notification_links
      WHERE payment_attempt_id = $1 AND kind = 'late-payment' ORDER BY mapping_status`, [started.attempt.id]);
    expect(links.rows).toEqual([
      { event_id: outbox.rows[0]!.id, mapping_status: 'mapping_failed', refund_id: wrongRefundId },
      { event_id: started.attempt.id, mapping_status: 'requested', refund_id: expect.any(String) },
    ]);
    const requests = await runtime.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM platform_notifications WHERE reference = $1`,
    [`booking-reservation:${started.attempt.id}:booking.reservation.late-payment`]);
    expect(requests.rows).toEqual([{ count: '1' }]);
  }, 120_000);

  it('keeps two Late Attempts on one cancelled Reservation as separate alerts and refunds', async () => {
    const fixture = await createReservation('two-late-attempt-alerts');
    const first = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_failed', reference: first.attempt.reference, providerRef: `two-late-failed:${first.attempt.id}`,
      message: 'failed before retry',
    });
    const second = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'two Late Attempts',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: first.attempt.reference, providerRef: `two-late-first:${first.attempt.id}`,
    });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: second.attempt.reference, providerRef: `two-late-second:${second.attempt.id}`,
    });
    await drainBookingNotificationWork();
    const alerts = await runtime.database.pool.query<{ payment_attempt_id: string; refund_id: string; reference: string }>(`
      SELECT payment_attempt_id, refund_id, reference FROM booking_reservation_notification_links
      WHERE reservation_id = $1 AND kind = 'late-payment' ORDER BY payment_attempt_id`, [fixture.reservation.id]);
    expect(alerts.rows.map(row => row.payment_attempt_id)).toEqual([first.attempt.id, second.attempt.id].sort());
    expect(new Set(alerts.rows.map(row => row.refund_id)).size).toBe(2);
    expect(new Set(alerts.rows.map(row => row.reference)).size).toBe(2);
    expect(await reservedCounts(fixture.roomType.id)).toEqual([0, 0]);
  }, 120_000);

  it('serializes competing Late initiation and callback outcomes into one alert event', async () => {
    const fixture = await createReservation('late-initiation-callback-race');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'Late outcome race',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    const providerRef = `late-race:${started.attempt.id}`;
    await Promise.all([
      runtime.commands.execute('booking.reservation.recordPaymentResult', {
        attemptId: started.attempt.id, provider: bookingPaymentProviderId,
        result: { status: 'confirmed', providerRef },
      }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() }),
      recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
        type: 'payment_confirmed', reference: started.attempt.reference, providerRef,
      }),
    ]);
    const events = await runtime.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM platform_outbox
      WHERE event_name = 'booking.reservation.latePayment.v1'
        AND payload->>'paymentAttemptId' = $1`, [started.attempt.id]);
    expect(events.rows).toEqual([{ count: '1' }]);
    await drainBookingNotificationWork();
    const alerts = await runtime.database.pool.query<{ links: string; requests: string; refunds: string }>(`
      SELECT (SELECT count(*)::text FROM booking_reservation_notification_links
        WHERE payment_attempt_id = $1 AND kind = 'late-payment') AS links,
        (SELECT count(*)::text FROM platform_notifications
        WHERE reference = 'booking-reservation:' || $1 || ':booking.reservation.late-payment') AS requests,
        (SELECT count(*)::text FROM booking_reservation_refunds WHERE payment_attempt_id = $1) AS refunds`,
    [started.attempt.id]);
    expect(alerts.rows).toEqual([{ links: '1', requests: '1', refunds: '1' }]);
  }, 120_000);

  it('retries the same exhausted Late event job after the operator mailbox is configured', async () => {
    await drainBookingNotificationWork();
    const fixture = await createReservation('late-alert-recipient-repair');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', {
        reservationId: fixture.reservation.id, method: 'deferred',
        checkoutCredential: await checkoutCredentialFor(fixture.reservation.id),
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'missing mailbox fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: started.attempt.reference,
      providerRef: `missing-mailbox:${started.attempt.id}`,
    });
    let missing: Runtime | undefined;
    let repaired: Runtime | undefined;
    try {
      missing = await createAlertRepairRuntime();
      const missingWorker = new Worker(missing, { workerId: `missing-mailbox-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      await missingWorker.relayOutbox();
      const job = await runtime.database.pool.query<{ id: string }>(`
        SELECT id FROM platform_jobs WHERE type = 'platform.event.deliver'
          AND payload->'event'->'payload'->>'paymentAttemptId' = $1`, [started.attempt.id]);
      expect(job.rows).toHaveLength(1);
      await runtime.database.pool.query('UPDATE platform_jobs SET max_attempts = 1 WHERE id = $1', [job.rows[0]!.id]);
      for (let round = 0; round < 20; round++) {
        await missingWorker.runJobs();
        const state = await runtime.database.pool.query<{ status: string }>('SELECT status FROM platform_jobs WHERE id = $1', [job.rows[0]!.id]);
        if (state.rows[0]?.status === 'dead') break;
      }
      const failed = await runtime.database.pool.query<{ mapping_status: string; mapping_failure_code: string }>(`
        SELECT mapping_status, mapping_failure_code FROM booking_reservation_notification_links
        WHERE payment_attempt_id = $1 AND kind = 'late-payment'`, [started.attempt.id]);
      expect(failed.rows).toEqual([{ mapping_status: 'mapping_retryable', mapping_failure_code: 'materialization_retryable' }]);
      await expect(runtime.database.pool.query('SELECT status FROM platform_jobs WHERE id = $1', [job.rows[0]!.id]))
        .resolves.toMatchObject({ rows: [{ status: 'dead' }] });
      await missing.close();
      missing = undefined;

      repaired = await createAlertRepairRuntime('repaired-alerts@example.test');
      await repaired.commands.execute('platform.jobs.retryJob', { jobId: job.rows[0]!.id },
        { actor: actor(['jobs:write']), idempotencyKey: randomUUID() });
      const repairedWorker = new Worker(repaired, { workerId: `repaired-mailbox-${randomUUID().slice(0, 8)}`, concurrency: 1 });
      for (let round = 0; round < 20; round++) {
        await repairedWorker.runJobs();
        const state = await runtime.database.pool.query<{ mapping_status: string }>(`
          SELECT mapping_status FROM booking_reservation_notification_links
          WHERE payment_attempt_id = $1 AND kind = 'late-payment'`, [started.attempt.id]);
        if (state.rows[0]?.mapping_status === 'requested') break;
      }
      const delivered = await runtime.database.pool.query<{ mapping_status: string; recipient_email: string }>(`
        SELECT l.mapping_status, n.recipient_email FROM booking_reservation_notification_links l
        JOIN platform_notifications n ON n.reference = l.reference
        WHERE l.payment_attempt_id = $1 AND l.kind = 'late-payment'`, [started.attempt.id]);
      expect(delivered.rows).toEqual([{ mapping_status: 'requested', recipient_email: 'repaired-alerts@example.test' }]);
      expect(await reservedCounts(fixture.roomType.id)).toEqual([0, 0]);
    } finally {
      await Promise.allSettled([missing?.close(), repaired?.close()].filter(Boolean) as Promise<void>[]);
    }
  }, 120_000);

  it('records a failed event-to-notification mapping separately while leaving the cancelled Reservation and released Room Nights intact', async () => {
    const fixture = await createReservation('notification-mapping-failure');
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET booker_email = NULL WHERE id = $1', [fixture.reservation.id]);
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: fixture.reservation.id, refundAmountMinor: 0, reason: 'mapping failure fixture',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 1 });
    const mapping = await runtime.database.pool.query<{ mapping_status: string; mapping_failure_code: string; reference: string }>(`
      SELECT mapping_status, mapping_failure_code, reference FROM booking_reservation_notification_links
      WHERE reservation_id = $1`, [fixture.reservation.id]);
    expect(mapping.rows).toEqual([{ mapping_status: 'mapping_failed', mapping_failure_code: 'booker_unavailable', reference: expect.any(String) }]);
    const requestCount = await runtime.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM platform_notifications WHERE reference = $1', [mapping.rows[0]!.reference],
    );
    expect(requestCount.rows).toEqual([{ count: '0' }]);
    expect(await reservedCounts(fixture.roomType.id)).toEqual([0, 0]);
    const reservation = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM booking_reservation_reservations WHERE id = $1', [fixture.reservation.id],
    );
    expect(reservation.rows).toEqual([{ status: 'cancelled' }]);
  }, 120_000);

  it('keeps a transient Base materialization failure retryable, then the same event creates exactly one request', async () => {
    const fixture = await createReservation('notification-retryable-materialization');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: fixture.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(fixture.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    const expiresAt = new Date(new Date(fixture.reservation.paymentExpiresAt).getTime() - 30_000).toISOString();
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: started.attempt.reference, providerRef: 'notification:retryable',
      instructions: [{ label: 'Bank code', value: '123456' }], expiresAt,
    });
    await runtime.database.pool.query(`CREATE OR REPLACE FUNCTION public.fail_booking_notification_materialization()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.reference LIKE 'booking-reservation:%' THEN RAISE EXCEPTION 'temporary notification storage failure'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER booking_notification_materialization_failure
      BEFORE INSERT ON public.platform_notifications
      FOR EACH ROW EXECUTE FUNCTION public.fail_booking_notification_materialization();`);
    try {
      await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 1 });
    } finally {
      await runtime.database.pool.query(`DROP TRIGGER IF EXISTS booking_notification_materialization_failure ON public.platform_notifications;
        DROP FUNCTION IF EXISTS public.fail_booking_notification_materialization();`);
    }
    const first = await runtime.database.pool.query<{
      event_id: string; mapping_status: string; mapping_failure_code: string; reference: string;
    }>(`SELECT event_id, mapping_status, mapping_failure_code, reference
      FROM booking_reservation_notification_links WHERE reservation_id = $1`, [fixture.reservation.id]);
    expect(first.rows).toEqual([expect.objectContaining({
      mapping_status: 'mapping_retryable', mapping_failure_code: 'materialization_retryable', reference: expect.any(String),
    })]);
    const eventId = first.rows[0]!.event_id;
    await runtime.database.pool.query(`UPDATE platform_jobs SET status = 'pending', run_at = pg_catalog.clock_timestamp()
      WHERE type = 'platform.event.deliver' AND payload->'event'->>'id' = $1`, [eventId]);
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 0 });
    const final = await runtime.database.pool.query<{ mapping_status: string; mapping_failure_code: string | null; reference: string }>(`
      SELECT mapping_status, mapping_failure_code, reference FROM booking_reservation_notification_links WHERE reservation_id = $1
    `, [fixture.reservation.id]);
    expect(final.rows).toEqual([{ mapping_status: 'requested', mapping_failure_code: null, reference: first.rows[0]!.reference }]);
    const counts = await runtime.database.pool.query<{ links: string; requests: string }>(`
      SELECT
        (SELECT count(*)::text FROM booking_reservation_notification_links WHERE reservation_id = $1) AS links,
        (SELECT count(*)::text FROM platform_notifications WHERE reference = $2) AS requests
    `, [fixture.reservation.id, first.rows[0]!.reference]);
    expect(counts.rows).toEqual([{ links: '1', requests: '1' }]);
  }, 120_000);

  it('upgrades a retryable event mapping to terminal Booker evidence and lets the following event retry settle', async () => {
    const fixture = await createReservation('notification-retryable-then-terminal');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: fixture.reservation.id, method: 'deferred', checkoutCredential: await checkoutCredentialFor(fixture.reservation.id) },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await clearPaymentAttemptJobs(fixture.reservation.id);
    const expiresAt = new Date(new Date(fixture.reservation.paymentExpiresAt).getTime() - 30_000).toISOString();
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_info_issued', reference: started.attempt.reference, providerRef: 'notification:retryable-terminal',
      instructions: [{ label: 'Bank code', value: '123456' }], expiresAt,
    });
    await runtime.database.pool.query(`CREATE OR REPLACE FUNCTION public.fail_booking_notification_materialization()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.reference LIKE 'booking-reservation:%' THEN RAISE EXCEPTION 'temporary notification storage failure'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER booking_notification_materialization_failure
      BEFORE INSERT ON public.platform_notifications
      FOR EACH ROW EXECUTE FUNCTION public.fail_booking_notification_materialization();`);
    try {
      await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 1 });
    } finally {
      await runtime.database.pool.query(`DROP TRIGGER IF EXISTS booking_notification_materialization_failure ON public.platform_notifications;
        DROP FUNCTION IF EXISTS public.fail_booking_notification_materialization();`);
    }
    const retryable = await runtime.database.pool.query<{ event_id: string }>(`
      SELECT event_id FROM booking_reservation_notification_links WHERE reservation_id = $1 AND mapping_status = 'mapping_retryable'
    `, [fixture.reservation.id]);
    const eventId = retryable.rows[0]!.event_id;
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET booker_email = NULL WHERE id = $1', [fixture.reservation.id]);
    await runtime.database.pool.query(`UPDATE platform_jobs SET status = 'pending', run_at = pg_catalog.clock_timestamp()
      WHERE type = 'platform.event.deliver' AND payload->'event'->>'id' = $1`, [eventId]);
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 1 });
    await expect(runtime.database.pool.query(`SELECT mapping_status, mapping_failure_code
      FROM booking_reservation_notification_links WHERE reservation_id = $1`, [fixture.reservation.id]))
      .resolves.toMatchObject({ rows: [{ mapping_status: 'mapping_failed', mapping_failure_code: 'booker_unavailable' }] });
    // Terminal linkage short-circuits the event's next delivery without ever
    // issuing a grant or creating a Base request.
    await runtime.database.pool.query(`UPDATE platform_jobs SET status = 'pending', run_at = pg_catalog.clock_timestamp()
      WHERE type = 'platform.event.deliver' AND payload->'event'->>'id' = $1`, [eventId]);
    await expect(drainBookingNotificationWork()).resolves.toMatchObject({ failed: 0 });
    await expect(runtime.database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM platform_notifications
      WHERE reference LIKE 'booking-reservation:' || $1 || ':%'
    `, [eventId])).resolves.toMatchObject({ rows: [{ count: '0' }] });
  }, 120_000);

  it('uses a hash-only checkout credential before payment lookup and revokes it on confirmation', async () => {
    const { reservation } = await createReservation('checkout-access-auth');
    const credential = await checkoutCredentialFor(reservation.id);
    const before = await paymentAttemptsFor(reservation.id);
    for (const input of [
      { reservationId: reservation.id, checkoutCredential: '' },
      { reservationId: reservation.id, checkoutCredential: `${credential}x` },
      { reservationId: randomUUID(), checkoutCredential: credential },
    ]) {
      await expect(runtime.commands.execute('booking.reservation.startPayment', {
        ...input, method: 'not-a-configured-method',
      }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await paymentAttemptsFor(reservation.id)).toEqual(before);

    const stored = await runtime.database.pool.query<{ checkout_credential_hash: string; row_json: string }>(`
      SELECT checkout_credential_hash, row_to_json(booking_reservation_reservations)::text AS row_json
      FROM booking_reservation_reservations WHERE id = $1
    `, [reservation.id]);
    expect(stored.rows[0]?.checkout_credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.row_json).not.toContain(credential);

    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>('booking.reservation.startPayment', {
      reservationId: reservation.id, method: 'deferred', checkoutCredential: credential,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() });
    await recordVerifiedPaymentOutcome(bookingPaymentProviderId, {
      type: 'payment_confirmed', reference: started.attempt.reference, providerRef: `checkout-confirm:${started.attempt.id}`,
    });
    await expect(runtime.database.pool.query<{ revoked_at: Date | null }>(`
      SELECT checkout_credential_revoked_at AS revoked_at
      FROM booking_reservation_reservations WHERE id = $1
    `, [reservation.id])).resolves.toMatchObject({ rows: [{ revoked_at: expect.any(Date) }] });
    await expect(runtime.commands.execute('booking.reservation.startPayment', {
      reservationId: reservation.id, method: 'not-a-configured-method', checkoutCredential: credential,
    }, { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const cancelled = await createReservation('checkout-access-cancel-revocation');
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: cancelled.reservation.id, refundAmountMinor: 0, reason: 'checkout credential revocation assertion',
    }, { actor: OPERATOR_ACTOR, idempotencyKey: randomUUID() });
    const expired = await createReservation('checkout-access-expiry-revocation');
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1', [expired.reservation.id, expiredAt]);
    await expireReservation(expired.reservation.id, expiredAt);
    const terminal = await runtime.database.pool.query<{ id: string; revoked_at: Date | null }>(`
      SELECT id, checkout_credential_revoked_at AS revoked_at
      FROM booking_reservation_reservations WHERE id = ANY($1::uuid[])
    `, [[cancelled.reservation.id, expired.reservation.id]]);
    expect(terminal.rows).toHaveLength(2);
    expect(terminal.rows.every(row => row.revoked_at instanceof Date)).toBe(true);

    const retained = await createReservation('checkout-access-retention-revocation');
    await makeRetentionEligible(retained.reservation.id);
    await expect(enqueueAndRunRetentionJob(`checkout-access-retention:${randomUUID()}`)).resolves.toMatchObject({ failed: 0 });
    await expect(runtime.database.pool.query<{
      key_id: string | null; nonce: string | null; hash: string | null; expires_at: Date | null; revoked_at: Date | null;
    }>(`SELECT checkout_credential_key_id AS key_id, checkout_credential_nonce AS nonce,
        checkout_credential_hash AS hash, checkout_credential_expires_at AS expires_at,
        checkout_credential_revoked_at AS revoked_at
      FROM booking_reservation_reservations WHERE id = $1`, [retained.reservation.id]))
      .resolves.toMatchObject({ rows: [{ key_id: null, nonce: null, hash: null, expires_at: null, revoked_at: expect.any(Date) }] });
  }, 120_000);

  it('upgrades a persisted 0011 materialization failure forward into retryable evidence', async () => {
    const upgradeContainer = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('booking_notification_0011_upgrade').withUsername('booking').withPassword('booking').start();
    let legacyRuntime: Runtime | undefined;
    let upgradedRuntime: Runtime | undefined;
    try {
      const config = baseConfigSchema.parse({
        version: 1, store: { id: 'booking-notification-0011-upgrade', name: 'Booking Notification 0011 Upgrade' },
        database: { url: upgradeContainer.getConnectionUri() }, logging: { level: 'error' },
        security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
      });
      const secrets = {
        get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? TEST_SECRET : undefined,
        has: (name: string) => name === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'],
      };
      const upgradeKeyring = resolveKeyring(config, secrets)!;
      const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
      const quoteReservationBinding = bindBookingAvailabilityQuoteReservation(propertyBinding, QUOTE_LIMITS, upgradeKeyring);
      const roomNightOperationsBinding = bindModuleCapability(
        'booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, testRoomNightOperations,
      );
      const reservationModule = createBookingReservationModule(
        quoteReservationBinding, roomNightOperationsBinding, createBookingReservationAccess(upgradeKeyring),
        RETENTION_POLICY, bookingPaymentProvider,
      );
      const legacyReservationModule = {
        ...reservationModule,
        migrations: { ...bookingReservationMigrations, migrations: bookingReservationMigrations.migrations.slice(0, 11) },
      };
      const options = {
        release: { id: 'booking-notification-0011-upgrade', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
        roles: BASE_ROLES, config, secrets, logger: noopLogger, availableExtensions: {},
      };
      legacyRuntime = await createRuntime({
        ...options,
        modules: [
          createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, upgradeKeyring), createBookingPropertyModule(), legacyReservationModule,
        ],
      });
      await legacyRuntime.migrate();
      const reservationId = randomUUID();
      const eventId = randomUUID();
      await legacyRuntime.database.pool.query(`INSERT INTO booking_reservation_reservations (
        id, room_type_id, check_in_local_date, check_out_local_date, room_count, adults, children,
        booker_name, booker_email, booker_phone, primary_guest_name, status, payment_expires_at,
        currency, total_minor, nightly_prices, cancellation_policy, quote_fingerprint
      ) VALUES ($1, $2, '2026-10-01', '2026-10-02', 1, 1, 0,
        'Legacy Booker', 'legacy@example.test', '000', 'Legacy Guest', 'pending_payment', clock_timestamp(),
        'USD', 24690, '[]'::jsonb, '{}'::jsonb, 'booking-quote-v1:legacy:${'b'.repeat(64)}')`, [reservationId, randomUUID()]);
      await legacyRuntime.database.pool.query(`INSERT INTO booking_reservation_notification_links (
        id, reservation_id, event_id, kind, template_id, reference, mapping_status, mapping_failure_code
      ) VALUES ($1, $2, $3, 'payment-expiring', 'booking.reservation.payment-expiring', $4,
        'mapping_failed', 'materialization_failed')`, [randomUUID(), reservationId, eventId, `booking-reservation:${eventId}:booking.reservation.payment-expiring`]);
      await legacyRuntime.close();
      legacyRuntime = undefined;

      upgradedRuntime = await createRuntime({
        ...options,
        modules: [
          createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, upgradeKeyring), createBookingPropertyModule(), reservationModule,
        ],
      });
      await expect(upgradedRuntime.migrate()).resolves.toEqual(expect.arrayContaining([
        'booking-reservation/0012_reservation_notification_retryable_mapping_failure',
        'booking-reservation/0013_reservation_checkout_credentials',
      ]));
      await expect(upgradedRuntime.database.pool.query(`SELECT mapping_status, mapping_failure_code
        FROM booking_reservation_notification_links WHERE reservation_id = $1`, [reservationId]))
        .resolves.toMatchObject({ rows: [{ mapping_status: 'mapping_retryable', mapping_failure_code: 'materialization_retryable' }] });
      await expect(upgradedRuntime.database.pool.query(`SELECT checkout_credential_key_id,
        checkout_credential_nonce, checkout_credential_hash, checkout_credential_expires_at,
        checkout_credential_revoked_at FROM booking_reservation_reservations WHERE id = $1`, [reservationId]))
        .resolves.toMatchObject({ rows: [{ checkout_credential_key_id: null, checkout_credential_nonce: null,
          checkout_credential_hash: null, checkout_credential_expires_at: null, checkout_credential_revoked_at: null }] });
      await expect(upgradedRuntime.database.transaction(tx => createBookingReservationAccess(upgradeKeyring).checkout.present(tx, reservationId)))
        .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await Promise.allSettled([...(legacyRuntime ? [legacyRuntime.close()] : []), ...(upgradedRuntime ? [upgradedRuntime.close()] : [])]);
      await upgradeContainer.stop();
    }
  }, 120_000);
});
