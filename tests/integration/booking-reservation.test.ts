import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { sha256Hex, signValue, type Keyring } from '@storeweave/crypto';
import type { PaymentInitiationInput, PaymentInitiationResult, PaymentMethod, PaymentProviderV2 } from '@storeweave/extension-sdk';
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
import { createBookingReservationModule } from '../../packages/booking/reservation/src/module';

const actor = (permissions: string[]): Actor => ({
  id: 'test:booking-reservation', type: 'user', displayName: 'Booking Reservation Test', permissions,
});
const PROPERTY_MANAGER = actor(['booking-property:manage', 'booking-availability:manage']);
const RESERVATION_ACTOR = actor([
  'booking-property:manage', 'booking-availability:manage', 'booking-availability:quote',
  'booking-reservation:create', 'booking-reservation:pay', 'booking-reservation:claim', 'booking-reservation:read-self',
  'booking-reservation:read-managed', 'booking-reservation:manage-self',
]);
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
  refund: async () => ({ status: 'unsupported', message: 'not used by Reservation payment-attempt tests' }),
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
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(runtime.commands.execute('booking.reservation.startPayment', {
      reservationId: reservation.id,
      method: 'deferred',
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
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    expect(retry.attempt.reference).not.toBe(failed.attempt.reference);

    await runtime.database.pool.query(`
      UPDATE booking_reservation_payment_attempts
      SET expires_at = pg_catalog.clock_timestamp() - interval '1 second'
      WHERE id = $1
    `, [retry.attempt.id]);
    const retryAfterExpiry = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
    const laterStarted = await runtime.commands.execute<{ attempt: { id: string } }>(
      'booking.reservation.startPayment', { reservationId: laterReservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 1, failed: 0 });
    const laterStored = await runtime.database.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM booking_reservation_payment_attempts WHERE id = $1', [laterStarted.attempt.id],
    );
    expect(laterStored.rows).toEqual([{ expires_at: laterReservationDeadline }]);
    await clearPaymentAttemptJobs(reservation.id);
    await clearPaymentAttemptJobs(laterReservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('retains synchronous confirmation evidence and dead-letters it pending SW-128 winner selection', async () => {
    paymentInitiations.length = 0;
    paymentResult = input => ({ status: 'confirmed', providerRef: `booking-test:${input.reference}` });
    const { roomType, reservation } = await createReservation('payment-attempt-synchronous-confirmation');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    );
    const worker = new Worker(runtime, { workerId: `booking-payment-confirmed-${randomUUID().slice(0, 8)}`, concurrency: 1 });
    await expect(worker.runJobs()).resolves.toMatchObject({ processed: 0, failed: 1 });

    const attempt = await runtime.database.pool.query<{ status: string; provider_ref: string; failure_message: string }>(`
      SELECT status, provider_ref, failure_message
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(attempt.rows).toEqual([{
      status: 'created', provider_ref: `booking-test:${started.attempt.reference}`,
      failure_message: 'Synchronous confirmation awaits Booking winner selection',
    }]);
    const job = await runtime.database.pool.query<{ status: string }>(`
      SELECT status FROM platform_jobs
      WHERE type = 'booking.reservation.process-payment' AND payload->>'attemptId' = $1
    `, [started.attempt.id]);
    expect(job.rows).toEqual([{ status: 'dead' }]);
    const storedReservation = await runtime.database.pool.query<{ status: string }>(
      'SELECT status FROM booking_reservation_reservations WHERE id = $1', [reservation.id],
    );
    expect(storedReservation.rows).toEqual([{ status: 'pending_payment' }]);
    expect(await reservedCounts(roomType.id)).toEqual([1, 1]);
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await clearPaymentAttemptJobs(reservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('rejects invalid methods and terminal Reservations without creating an Attempt', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    paymentMethods = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];
    paymentSetupError = undefined;
    const { reservation } = await createReservation('payment-attempt-invalid');
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'unknown' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);

    paymentMethods = [{ code: 'immediate', label: 'Immediate test payment', timing: 'immediate' }];
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'immediate' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    paymentMethods = [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }];

    paymentSetupError = new Error('payment provider is not configured');
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toThrow('payment provider is not configured');
    paymentSetupError = undefined;
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);

    await runtime.database.pool.query(
      "UPDATE booking_reservation_reservations SET status = 'cancelled' WHERE id = $1",
      [reservation.id],
    );
    await expect(runtime.commands.execute(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
      { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await paymentAttemptsFor(reservation.id)).toEqual([]);
    expect(paymentInitiations).toEqual([]);
  }, 120_000);

  it('expires active Attempts before releasing the Reservation Room Nights and retains a late confirmation', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    const { roomType, reservation } = await createReservation('payment-attempt-reservation-expiry');
    const started = await runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
    const lateAttempt = await runtime.database.pool.query<{ status: string; provider_ref: string; failure_message: string }>(`
      SELECT status, provider_ref, failure_message
      FROM booking_reservation_payment_attempts WHERE id = $1
    `, [started.attempt.id]);
    expect(lateAttempt.rows).toEqual([{
      status: 'expired', provider_ref: `booking-test:${started.attempt.reference}`,
      failure_message: 'Synchronous confirmation awaits Booking winner selection',
    }]);
    await clearPaymentAttemptJobs(reservation.id);
    paymentResult = defaultPaymentResult;
  }, 120_000);

  it('dead-letters a queued Attempt when the configured Provider changes before invocation', async () => {
    paymentInitiations.length = 0;
    paymentResult = defaultPaymentResult;
    const { reservation } = await createReservation('payment-attempt-provider-change');
    const started = await runtime.commands.execute<{ attempt: { id: string } }>(
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
        'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
        { actor: RESERVATION_ACTOR, idempotencyKey: randomUUID() },
      ),
      runtime.commands.execute<{ attempt: { id: string; reference: string } }>(
        'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
      'booking.reservation.startPayment', { reservationId: reservation.id, method: 'deferred' },
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
      .resolves.toMatchObject({ processed: 1, failed: 0 });
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
      .resolves.toMatchObject({ processed: 1, failed: 0 });

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

    const finalRows = await runtime.database.pool.query<{
      id: string; booker_name: string | null; primary_guest_name: string | null;
      owner_account_id: string | null; pii_anonymized_at: Date | null; access_generation: number;
      access_grant_nonce: string | null; access_grant_expires_at: Date | null;
      access_grant_used_at: Date | null; management_token_hash: string | null;
    }>(`
      SELECT id, booker_name, primary_guest_name, owner_account_id, pii_anonymized_at,
             access_generation, access_grant_nonce, access_grant_expires_at,
             access_grant_used_at, management_token_hash
      FROM booking_reservation_reservations WHERE id = ANY($1::uuid[])
    `, [reservations.map(reservation => reservation.id)]);
    expect(finalRows.rows).toHaveLength(reservations.length);
    expect(finalRows.rows.every(row => row.booker_name === null && row.primary_guest_name === null
      && row.owner_account_id === null && row.pii_anonymized_at instanceof Date
      && row.access_generation === 0 && row.access_grant_nonce === null && row.access_grant_expires_at === null
      && row.access_grant_used_at === null && row.management_token_hash === null)).toBe(true);
  }, 180_000);
});
