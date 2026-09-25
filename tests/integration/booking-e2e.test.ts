import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { signValue } from '@storeweave/crypto';
import { csrfTokenFor } from '@storeweave/identity';
import { bindModuleCapability, createRuntime, resolveKeyring, Worker, type Runtime } from '@storeweave/kernel';
import {
  paymentInitiationInputSchema, paymentRefundInputSchema, runPaymentProviderContractChecks,
  type PaymentCallbackEvent, type PaymentInitiationInput, type PaymentInitiationResult,
  type PaymentProviderV2, type PaymentRefundInputV2, type PaymentRefundResult,
} from '@storeweave/extension-sdk';
import {
  bindBookingAvailabilityQuoteReservation, BOOKING_PROPERTY_READ_CAPABILITY,
  createBookingAvailabilityModule, BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  bookingAvailabilityRoomNightOperations,
} from '../../packages/booking/availability/src';
import { bookingPropertyRead, createBookingPropertyModule } from '../../packages/booking/property/src';
import {
  BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE, createBookingReservationAccess,
  createBookingReservationModule,
} from '../../packages/booking/reservation/src';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { bookingHttpAdapter } from '../../apps/api/src/releases/booking';
import { SESSION_COOKIE, cookieName } from '../../apps/api/src/http/cookie-names';

const signingSecret = Buffer.alloc(32, 31).toString('base64url');
const callbackSecret = 'local-booking-e2e-signature';
const manager: Actor = {
  id: 'test:booking-e2e-manager', type: 'user', displayName: 'Booking E2E Manager',
  permissions: ['booking-property:manage', 'booking-availability:manage'],
};
const charges = new Map<string, { input: PaymentInitiationInput; result: PaymentInitiationResult }>();
const refunds = new Map<string, { input: PaymentRefundInputV2; result: PaymentRefundResult }>();
let rejectNextPayment = false;
let rejectRefunds = false;

// Local provider implements the reference/replay/refund ABI. Deferred payments are
// confirmed only by a signed callback; an immediate initiation cannot prove races.
const provider: PaymentProviderV2 = {
  id: 'booking-e2e-local', kind: 'payment',
  paymentMethods: () => [
    { code: 'immediate', label: 'Local immediate', timing: 'immediate' },
    { code: 'deferred', label: 'Local deferred', timing: 'deferred' },
  ],
  initiate: async raw => {
    const input = paymentInitiationInputSchema.parse(raw);
    const previous = charges.get(input.reference);
    if (previous) return JSON.stringify(previous.input) === JSON.stringify(input)
      ? previous.result
      : { status: 'failed', reason: 'reference_conflict', message: 'reference has different payment facts' };
    if (rejectNextPayment) {
      rejectNextPayment = false;
      return { status: 'failed', reason: 'provider_rejected', message: 'local decline' };
    }
    const providerRef = `local:${input.reference}`;
    const result: PaymentInitiationResult = input.method === 'immediate'
      ? { status: 'confirmed', providerRef }
      : { status: 'redirect', providerRef, action: { type: 'redirect', url: 'https://payments.example.test/continue' } };
    charges.set(input.reference, { input, result });
    return result;
  },
  refund: async raw => {
    const input = paymentRefundInputSchema.parse(raw);
    const previous = refunds.get(input.reference);
    if (previous) return JSON.stringify(previous.input) === JSON.stringify(input)
      ? previous.result : { status: 'rejected', message: 'refund reference has different facts' };
    const charge = [...charges.values()].find(value => value.result.status !== 'failed'
      && value.result.providerRef === input.providerRef);
    const result: PaymentRefundResult = rejectRefunds || !charge || charge.input.amount < input.amount
      || charge.input.currency !== input.currency
      ? { status: 'rejected', message: 'local refund rejected' }
      : { status: 'succeeded', providerRefundRef: `local-refund:${input.reference}` };
    refunds.set(input.reference, { input, result });
    return result;
  },
  parseCallback: async request => {
    const body = Buffer.from(request.body);
    if (request.headers['x-booking-signature'] !== createHmac('sha256', callbackSecret).update(body).digest('hex')) {
      throw new Error('invalid local callback signature');
    }
    return JSON.parse(body.toString('utf8')) as PaymentCallbackEvent;
  },
  acknowledgeCallback: result => ({ body: result.accepted ? 'accepted' : 'retry', statusCode: result.accepted ? 200 : 503 }),
};

let container: StartedPostgreSqlContainer;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof createReleaseServer>>;
let roomTypeId: string;
let access: ReturnType<typeof createBookingReservationAccess>;
let keyring: NonNullable<ReturnType<typeof resolveKeyring>>;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function stay(offset: number) {
  const checkInLocalDate = addDays(localDate(new Date()), offset);
  return { roomTypeId, checkInLocalDate, checkOutLocalDate: addDays(checkInLocalDate, 2), adults: 2, children: 0, roomCount: 1 };
}

async function quote(input: ReturnType<typeof stay>) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: input });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data.quote as { fingerprint: string; totalMinor: number };
}

async function create(input: ReturnType<typeof stay>, fingerprint: string) {
  return app.inject({ method: 'POST', url: '/api/v1/booking/reservations',
    headers: { 'idempotency-key': randomUUID() }, payload: {
      quote: { ...input, fingerprint },
      booker: { name: 'E2E Private Booker', email: 'e2e.booker@example.test', phone: '+1 555 0199' },
      primaryGuestName: 'E2E Private Guest', accommodationNotes: 'E2E Private Note',
    } });
}

async function roomNightCounts(input: ReturnType<typeof stay>) {
  const rows = await runtime.database.pool.query<{ reserved_units: number }>(`
    SELECT reserved_units FROM booking_availability_room_nights
    WHERE room_type_id = $1 AND local_date >= $2 AND local_date < $3 ORDER BY local_date
  `, [roomTypeId, input.checkInLocalDate, input.checkOutLocalDate]);
  return rows.rows.map(row => row.reserved_units);
}

async function reservationState(id: string) {
  const rows = await runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string | null }>(
    'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [id]);
  return rows.rows[0]!;
}

async function runWorkerUntil(predicate: () => Promise<boolean>, limit = 20) {
  const worker = new Worker(runtime, { workerId: `booking-e2e-${randomUUID().slice(0, 8)}`, concurrency: 1 });
  for (let i = 0; i < limit; i += 1) {
    await worker.relayOutbox();
    await worker.runJobs();
    if (await predicate()) return;
  }
  throw new Error('local Booking worker did not reach expected state');
}

function callback(event: PaymentCallbackEvent) {
  const payload = JSON.stringify(event);
  return app.inject({ method: 'POST', url: `/callbacks/payment/${provider.id}`, payload,
    headers: { 'content-type': 'application/json',
      'x-booking-signature': createHmac('sha256', callbackSecret).update(payload).digest('hex') } });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_e2e').withUsername('booking').withPassword('booking').start();
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-e2e', name: 'Booking E2E' },
    http: { publicUrl: 'https://booking.example.test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = { get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? signingSecret : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'] };
  keyring = resolveKeyring(config, secrets)!;
  const property = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const quoteReservation = bindBookingAvailabilityQuoteReservation(property, { maxRoomsPerRequest: 4 }, keyring);
  const roomNights = bindModuleCapability('booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
    bookingAvailabilityRoomNightOperations);
  access = createBookingReservationAccess(keyring);
  runtime = await createRuntime({
    release: { id: 'booking-e2e', version: '1.0.0', buildManifestChecksum: `sha256:${'e'.repeat(64)}` },
    roles: BASE_ROLES, config, secrets, logger: noopLogger, availableExtensions: {}, modules: [
      createBookingAvailabilityModule(property, { maxRoomsPerRequest: 4 }, keyring), createBookingPropertyModule(),
      createBookingReservationModule(quoteReservation, roomNights, access, { reservationPiiRetentionDays: 1 }, provider,
        'booking-alerts@example.test'),
    ],
  });
  runtime.providers.register({ provider, owner: 'booking-e2e-test' });
  await runtime.migrate();
  await runtime.commands.execute('booking.property.create', {
    name: 'E2E Hotel', address: { countryCode: 'US', postalCode: '90210', administrativeArea: 'California',
      locality: 'Los Angeles', addressLine1: 'Ocean 1', addressLine2: null },
    timezone: 'America/Los_Angeles', currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  }, { actor: manager, idempotencyKey: randomUUID() });
  const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
    code: 'e2e', name: 'E2E Room', description: null, maxOccupancyPerUnit: 4,
    beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1,
    maximumStayNights: null, mediaAssetId: null,
  }, { actor: manager, idempotencyKey: randomUUID() });
  roomTypeId = room.id;
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
    roomTypeId, baseNightlyPriceMinor: 12_345,
  }, { actor: manager, idempotencyKey: randomUUID() });
  const startLocalDate = addDays(localDate(new Date()), 7);
  await runtime.commands.execute('booking.availability.updateRoomNightRange', {
    roomTypeId, startLocalDate, endLocalDateExclusive: addDays(startLocalDate, 30), sellableUnits: 1,
  }, { actor: manager, idempotencyKey: randomUUID() });
  app = await createReleaseServer({ runtime, httpAdapter: bookingHttpAdapter, release: { version: 'test', configPath: '<test>' } });
}, 120_000);

afterAll(async () => { await app?.close(); await runtime?.close(); await container?.stop(); });
afterEach(() => { rejectNextPayment = false; rejectRefunds = false; });

describe('SW-145 clean Booking E2E', () => {
  it('qualifies the local payment provider with the executable V2 initiation and refund contract', async () => {
    const input = { reference: `contract:${randomUUID()}`, displayReference: 'E2E-CONTRACT', amount: 100,
      currency: 'USD', method: 'immediate' };
    const cases = (['displayReference', 'amount', 'currency', 'method'] as const).map(field => ({
      field, input: { ...input, [field]: field === 'amount' ? 101
        : field === 'currency' ? 'EUR' : field === 'method' ? 'deferred' : 'E2E-CHANGED' },
    }));
    const checks = await runPaymentProviderContractChecks(provider, {
      initiation: input, expectedInitiationStatus: 'confirmed', changedReferenceInputs: cases,
      createdPaymentCount: () => charges.size, createdRefundCount: () => refunds.size,
      refunds: [{ name: 'full refund', input: { providerRef: `local:${input.reference}`, amount: 100,
        currency: 'USD', reference: `contract-refund:${randomUUID()}` }, expectedStatus: 'succeeded' }],
    });
    expect(checks.filter(check => !check.ok)).toEqual([]);
  });

  it('searches, quotes, pays, claims, cancels, refunds, then anonymizes after the configured deadline', async () => {
    const input = stay(7);
    const search = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes/search', payload: {
      checkInLocalDate: input.checkInLocalDate, checkOutLocalDate: input.checkOutLocalDate,
      adults: input.adults, children: input.children, roomCount: input.roomCount,
    } });
    expect(search.statusCode, search.body).toBe(201);
    expect(JSON.stringify(search.json())).toContain(roomTypeId);
    const priced = await quote(input);
    const created = await create(input, priced.fingerprint);
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string; status: string }; checkoutCredential: string;
    };
    expect(reservation.status).toBe('pending_payment');
    expect(await roomNightCounts(input)).toEqual([1, 1]);

    const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'immediate' } });
    expect(payment.statusCode, payment.body).toBe(202);
    await runWorkerUntil(async () => (await reservationState(reservation.id)).status === 'confirmed');
    const winner = await reservationState(reservation.id);
    expect(winner.winning_payment_attempt_id).toBe(payment.json().data.attemptId);
    expect(await roomNightCounts(input)).toEqual([1, 1]);

    const noProof = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservation.id}` });
    expect(noProof.statusCode).toBe(401);
    const issued = await runtime.database.transaction(tx => access.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const grantUrl = `/api/v1/booking/management/${reservation.id}/grants?grantToken=${encodeURIComponent(issued.grantToken)}`;
    const redeemed = await app.inject({ method: 'GET', url: grantUrl, remoteAddress: '198.51.100.31' });
    expect(redeemed.statusCode, redeemed.body).toBe(303);
    expect(redeemed.headers.location).toBe(`/api/v1/booking/management/${reservation.id}`);
    expect(redeemed.headers.location).not.toContain(issued.grantToken);
    const managementCookie = redeemed.cookies.find(cookie => cookie.name === '__Host-booking_reservation_management')!;
    expect(managementCookie).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(managementCookie.domain).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: grantUrl, remoteAddress: '198.51.100.31' })).statusCode).toBe(401);
    const cookies = { '__Host-booking_reservation_management': managementCookie.value };
    const managed = await app.inject({ method: 'GET', url: redeemed.headers.location!, cookies,
      remoteAddress: '198.51.100.31' });
    expect(managed.json().data.reservation).toMatchObject({ id: reservation.id, status: 'confirmed' });

    const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'e2e.booker@example.test', password: 'member-password' } });
    expect(register.statusCode, register.body).toBe(200);
    const session = register.cookies.find(cookie => cookie.name === cookieName(SESSION_COOKIE, 'https://booking.example.test'))!.value;
    const sessionCookie = { [cookieName(SESSION_COOKIE, 'https://booking.example.test')]: session };
    expect((await app.inject({ method: 'GET', url: redeemed.headers.location!, cookies: sessionCookie,
      remoteAddress: '198.51.100.31' })).statusCode).toBe(404);
    const claimWithoutProof = await app.inject({ method: 'POST', url: `${redeemed.headers.location}/claim`,
      cookies: sessionCookie, remoteAddress: '198.51.100.31',
      headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': randomUUID() } });
    expect(claimWithoutProof.statusCode).toBe(401);
    const claim = await app.inject({ method: 'POST', url: `${redeemed.headers.location}/claim`,
      cookies: { ...sessionCookie, ...cookies }, remoteAddress: '198.51.100.31',
      headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': randomUUID() } });
    expect(claim.statusCode, claim.body).toBe(200);

    const cancelled = await app.inject({ method: 'POST', url: `${redeemed.headers.location}/cancel`,
      cookies: { ...sessionCookie, ...cookies }, remoteAddress: '198.51.100.31',
      headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': randomUUID() } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().data).toMatchObject({ reservationId: reservation.id, cancelled: true });
    expect(await roomNightCounts(input)).toEqual([0, 0]);
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
      return row.rows[0]?.status === 'succeeded';
    });
    const refundEvidence = await runtime.database.pool.query<{ status: string; provider_refund_ref: string }>(
      'SELECT status, provider_refund_ref FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
    expect(refundEvidence.rows).toMatchObject([{ status: 'succeeded', provider_refund_ref: expect.stringMatching(/^local-refund:/) }]);
    const durableEvidence = async () => {
      const [attempts, refundRows, invocations, audits] = await Promise.all([
        runtime.database.pool.query(`SELECT id, reference, status, provider_ref, success_kind, succeeded_at
          FROM booking_reservation_payment_attempts WHERE reservation_id = $1 ORDER BY id`, [reservation.id]),
        runtime.database.pool.query(`SELECT id, payment_attempt_id, status, reason, provider_request_ref, provider_refund_ref
          FROM booking_reservation_refunds WHERE reservation_id = $1 ORDER BY id`, [reservation.id]),
        runtime.database.pool.query(`SELECT i.id, i.refund_id, i.generation, i.worker_attempt, i.outcome, i.provider_refund_ref
          FROM booking_reservation_refund_invocations i
          JOIN booking_reservation_refunds f ON f.id = i.refund_id
          WHERE f.reservation_id = $1 ORDER BY i.id`, [reservation.id]),
        runtime.database.pool.query(`SELECT id, action, resource_id, payload FROM platform_audit_log
          WHERE resource_id = $1::text OR resource_id IN (
            SELECT id::text FROM booking_reservation_refunds WHERE reservation_id = $1::uuid
          ) ORDER BY id`, [reservation.id]),
      ]);
      return { attempts: attempts.rows, refunds: refundRows.rows, invocations: invocations.rows, audits: audits.rows };
    };
    const evidenceBeforeRetention = await durableEvidence();
    expect(evidenceBeforeRetention.attempts).toHaveLength(1);
    expect(evidenceBeforeRetention.refunds).toHaveLength(1);
    expect(evidenceBeforeRetention.invocations).toHaveLength(1);
    expect(evidenceBeforeRetention.audits.length).toBeGreaterThan(0);

    // Advance only the frozen stay dates. The retention command reads the real
    // PostgreSQL clock, so the configured one-day deadline has elapsed.
    const now = await runtime.database.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const checkOut = addDays(localDate(now.rows[0]!.now), -2);
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET check_in_local_date = $2, check_out_local_date = $3 WHERE id = $1`,
    [reservation.id, addDays(checkOut, -2), checkOut]);
    const beforeRetention = await runtime.database.pool.query<{ booker_email: string; status: string; total_minor: number }>(
      'SELECT booker_email, status, total_minor::float8 AS total_minor FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
    expect(beforeRetention.rows[0]).toMatchObject({ booker_email: 'e2e.booker@example.test', status: 'cancelled', total_minor: priced.totalMinor });
    const bucket = Math.floor(now.rows[0]!.now.getTime() / 86_400_000);
    await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
      type: 'booking.reservation.anonymize-expired-pii',
      payload: { bucket, scheduledFor: now.rows[0]!.now.toISOString() },
      dedupeKey: `booking-e2e-retention:${randomUUID()}`, runAt: new Date(now.rows[0]!.now.getTime() - 1_000),
    }));
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ pii_anonymized_at: Date | null }>(
        'SELECT pii_anonymized_at FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
      return row.rows[0]?.pii_anonymized_at instanceof Date;
    });
    const retained = await runtime.database.pool.query<{
      status: string; booker_name: string | null; booker_email: string | null; booker_phone: string | null;
      primary_guest_name: string | null; accommodation_notes: string | null; owner_account_id: string | null;
      total_minor: number; winning_payment_attempt_id: string; management_token_hash: string | null;
    }>(`SELECT status, booker_name, booker_email, booker_phone, primary_guest_name, accommodation_notes,
      owner_account_id, total_minor::float8 AS total_minor, winning_payment_attempt_id, management_token_hash
      FROM booking_reservation_reservations WHERE id = $1`, [reservation.id]);
    expect(retained.rows).toEqual([{
      status: 'cancelled', booker_name: null, booker_email: null, booker_phone: null,
      primary_guest_name: null, accommodation_notes: null, owner_account_id: null,
      total_minor: priced.totalMinor, winning_payment_attempt_id: winner.winning_payment_attempt_id,
      management_token_hash: null,
    }]);
    const evidenceAfterRetention = await durableEvidence();
    expect(evidenceAfterRetention.attempts).toEqual(evidenceBeforeRetention.attempts);
    expect(evidenceAfterRetention.refunds).toEqual(evidenceBeforeRetention.refunds);
    expect(evidenceAfterRetention.invocations).toEqual(evidenceBeforeRetention.invocations);
    expect(evidenceAfterRetention.audits).toEqual(expect.arrayContaining(evidenceBeforeRetention.audits));
    expect((await app.inject({ method: 'GET', url: redeemed.headers.location!, cookies,
      remoteAddress: '198.51.100.31' })).statusCode).toBe(401);
  }, 180_000);

  it('returns one winner for the last Room Nights and no rows for stale or unavailable Quotes', async () => {
    const input = stay(12);
    const priced = await quote(input);
    const results = await Promise.all([create(input, priced.fingerprint), create(input, priced.fingerprint)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find(result => result.statusCode === 409)!.json().data).toEqual({ kind: 'unavailable' });
    expect(await roomNightCounts(input)).toEqual([1, 1]);
    const count = await runtime.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_reservation_reservations WHERE room_type_id = $1 AND check_in_local_date = $2',
      [roomTypeId, input.checkInLocalDate]);
    expect(count.rows).toEqual([{ count: '1' }]);

    const staleInput = stay(16);
    const oldQuote = await quote(staleInput);
    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
      roomTypeId, baseNightlyPriceMinor: 13_000,
    }, { actor: manager, idempotencyKey: randomUUID() });
    const stale = await create(staleInput, oldQuote.fingerprint);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().data).toMatchObject({ kind: 'stale', replacementQuote: { totalMinor: 26_000 } });
    expect(await roomNightCounts(staleInput)).toEqual([0, 0]);
    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId, startLocalDate: staleInput.checkInLocalDate,
      endLocalDateExclusive: staleInput.checkOutLocalDate, sellableUnits: 0,
    }, { actor: manager, idempotencyKey: randomUUID() });
    const unavailable = await create(staleInput, oldQuote.fingerprint);
    expect(unavailable.statusCode, unavailable.body).toBe(409);
    expect(unavailable.json().data).toEqual({ kind: 'unavailable' });
    expect(await roomNightCounts(staleInput)).toEqual([0, 0]);
    const noRows = await runtime.database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_reservation_reservations WHERE room_type_id = $1 AND check_in_local_date = $2',
      [roomTypeId, staleInput.checkInLocalDate]);
    expect(noRows.rows).toEqual([{ count: '0' }]);
  }, 120_000);

  it('keeps a cancelled deferred Reservation released after a signed late callback and records refund failure', async () => {
    const input = stay(20);
    const priced = await quote(input);
    const created = await create(input, priced.fingerprint);
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string }; checkoutCredential: string;
    };
    const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'deferred' } });
    expect(payment.statusCode, payment.body).toBe(202);
    const attemptId = payment.json().data.attemptId as string;
    await runWorkerUntil(async () => {
      const result = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_payment_attempts WHERE id = $1', [attemptId]);
      return result.rows[0]?.status === 'submitted';
    });
    const attempt = await runtime.database.pool.query<{ reference: string; provider_ref: string }>(
      'SELECT reference, provider_ref FROM booking_reservation_payment_attempts WHERE id = $1', [attemptId]);
    const cancellation = await runtime.commands.execute<{ reservationId: string }>('booking.reservation.cancelByOperator', {
      reservationId: reservation.id, refundAmountMinor: 0, reason: 'E2E late callback',
    }, { actor: { ...manager, permissions: ['booking-reservation:cancel'] }, idempotencyKey: randomUUID() });
    expect(cancellation.reservationId).toBe(reservation.id);
    expect(await roomNightCounts(input)).toEqual([0, 0]);
    rejectRefunds = true;
    const event: PaymentCallbackEvent = { type: 'payment_confirmed', reference: attempt.rows[0]!.reference,
      providerRef: attempt.rows[0]!.provider_ref };
    const late = await callback(event);
    expect(late.statusCode, late.body).toBe(200);
    expect((await callback(event)).statusCode).toBe(200);
    await runWorkerUntil(async () => {
      const result = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
      return result.rows[0]?.status === 'failed';
    });
    expect(await reservationState(reservation.id)).toMatchObject({ status: 'cancelled', winning_payment_attempt_id: null });
    expect(await roomNightCounts(input)).toEqual([0, 0]);
    const evidence = await runtime.database.pool.query<{ success_kind: string; refunds: string }>(`
      SELECT a.success_kind,
        (SELECT count(*)::text FROM booking_reservation_refunds WHERE reservation_id = a.reservation_id) AS refunds
      FROM booking_reservation_payment_attempts a WHERE a.id = $1`, [attemptId]);
    expect(evidence.rows[0]).toMatchObject({ success_kind: 'late', refunds: '1' });
    await runWorkerUntil(async () => {
      const result = await runtime.database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM booking_reservation_notification_links
         WHERE reservation_id = $1 AND kind = 'late-payment' AND mapping_status = 'requested'`,
        [reservation.id]);
      return result.rows[0]?.count === '1';
    });
    const linked = await runtime.database.pool.query<{
      kind: string; template_id: string; payment_attempt_id: string; refund_id: string;
      recipient_email: string; variables: Record<string, unknown>; refund_reason: string;
    }>(`SELECT l.kind, l.template_id, l.payment_attempt_id, l.refund_id,
        n.recipient_email, n.variables, f.reason AS refund_reason
      FROM booking_reservation_notification_links l
      JOIN booking_reservation_refunds f ON f.id = l.refund_id
      JOIN platform_notifications n ON n.reference = l.reference
      WHERE l.reservation_id = $1 AND l.kind = 'late-payment'`, [reservation.id]);
    expect(linked.rows).toEqual([expect.objectContaining({
      kind: 'late-payment', template_id: 'booking.reservation.late-payment',
      payment_attempt_id: attemptId, refund_id: expect.any(String),
      refund_reason: 'late_payment', recipient_email: 'booking-alerts@example.test',
    })]);
    expect(linked.rows[0]!.variables).toEqual({
      reservationId: reservation.id, paymentAttemptId: attemptId, refundId: linked.rows[0]!.refund_id,
    });
    expect(JSON.stringify(linked.rows[0])).not.toMatch(/accessGrant|managementToken|private\.booker|provider_ref/i);
  }, 180_000);

  it('serializes two confirmed callbacks into one winner and one refunded Excess Payment', async () => {
    const input = stay(28);
    const created = await create(input, (await quote(input)).fingerprint);
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string }; checkoutCredential: string;
    };
    const start = () => app.inject({ method: 'POST',
      url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'deferred' },
    });
    const firstStart = await start();
    expect(firstStart.statusCode, firstStart.body).toBe(202);
    const firstId = firstStart.json().data.attemptId as string;
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_payment_attempts WHERE id = $1', [firstId]);
      return row.rows[0]?.status === 'submitted';
    });
    const first = await runtime.database.pool.query<{ reference: string; provider_ref: string }>(
      'SELECT reference, provider_ref FROM booking_reservation_payment_attempts WHERE id = $1', [firstId]);
    const failed = await callback({ type: 'payment_failed', reference: first.rows[0]!.reference,
      providerRef: first.rows[0]!.provider_ref, message: 'retry fixture' });
    expect(failed.statusCode, failed.body).toBe(200);

    const secondStart = await start();
    expect(secondStart.statusCode, secondStart.body).toBe(202);
    const secondId = secondStart.json().data.attemptId as string;
    expect(secondId).not.toBe(firstId);
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_payment_attempts WHERE id = $1', [secondId]);
      return row.rows[0]?.status === 'submitted';
    });
    const second = await runtime.database.pool.query<{ reference: string; provider_ref: string }>(
      'SELECT reference, provider_ref FROM booking_reservation_payment_attempts WHERE id = $1', [secondId]);
    const results = await Promise.all([
      callback({ type: 'payment_confirmed', reference: first.rows[0]!.reference,
        providerRef: first.rows[0]!.provider_ref }),
      callback({ type: 'payment_confirmed', reference: second.rows[0]!.reference,
        providerRef: second.rows[0]!.provider_ref }),
    ]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    const attempts = await runtime.database.pool.query<{ id: string; success_kind: string }>(
      'SELECT id, success_kind FROM booking_reservation_payment_attempts WHERE reservation_id = $1', [reservation.id]);
    expect(attempts.rows.map(row => row.success_kind).sort()).toEqual(['excess', 'winning']);
    const winner = await reservationState(reservation.id);
    expect(winner).toMatchObject({ status: 'confirmed',
      winning_payment_attempt_id: attempts.rows.find(row => row.success_kind === 'winning')!.id });
    expect(await roomNightCounts(input)).toEqual([1, 1]);
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
      return row.rows[0]?.status === 'succeeded';
    });
    const refund = await runtime.database.pool.query<{ reason: string; status: string }>(
      'SELECT reason, status FROM booking_reservation_refunds WHERE reservation_id = $1', [reservation.id]);
    expect(refund.rows).toEqual([{ reason: 'excess_payment', status: 'succeeded' }]);
    expect(await roomNightCounts(input)).toEqual([1, 1]);
  }, 180_000);

  it('rejects invalid input, failed payment, expired grant, late cancellation, and early retention; expiry frees both nights', async () => {
    const input = stay(25);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes',
      payload: { ...input, checkInLocalDate: 'invalid-date' } });
    expect(invalid.statusCode).toBe(400);
    const created = await create(input, (await quote(input)).fingerprint);
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string }; checkoutCredential: string;
    };
    rejectNextPayment = true;
    const failedStart = await app.inject({ method: 'POST',
      url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'immediate' } });
    expect(failedStart.statusCode, failedStart.body).toBe(202);
    const failedId = failedStart.json().data.attemptId as string;
    await runWorkerUntil(async () => {
      const row = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_payment_attempts WHERE id = $1', [failedId]);
      return row.rows[0]?.status === 'failed';
    });
    expect((await reservationState(reservation.id)).status).toBe('pending_payment');
    expect(await roomNightCounts(input)).toEqual([1, 1]);
    const retry = await app.inject({ method: 'POST',
      url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'deferred' } });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json().data.attemptId).not.toBe(failedId);

    const issued = await runtime.database.transaction(tx => access.issueGrant(tx, {
      reservationId: reservation.id, ttlMs: 15 * 60_000,
    }));
    const state = await runtime.database.pool.query<{ access_grant_nonce: string }>(
      'SELECT access_grant_nonce FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
    const expiredAt = new Date(Math.floor((Date.now() - 5_000) / 1_000) * 1_000);
    const expiredGrant = signValue(keyring, {
      purpose: BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
      payload: JSON.stringify({ version: 1, reservationId: reservation.id,
        generation: issued.generation, nonce: state.rows[0]!.access_grant_nonce }),
      expiresAt: expiredAt,
    });
    const grantUrl = (token: string) => `/api/v1/booking/management/${reservation.id}/grants?grantToken=${encodeURIComponent(token)}`;
    expect((await app.inject({ method: 'GET', url: grantUrl(expiredGrant), remoteAddress: '198.51.100.32' })).statusCode).toBe(401);
    const redeemed = await app.inject({ method: 'GET', url: grantUrl(issued.grantToken), remoteAddress: '198.51.100.32' });
    expect(redeemed.statusCode, redeemed.body).toBe(303);
    const cookies = { '__Host-booking_reservation_management': redeemed.cookies.find(
      cookie => cookie.name === '__Host-booking_reservation_management')!.value };
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET cancellation_policy = jsonb_set(cancellation_policy, '{freeCancellationHoursBeforeCheckIn}', '8760'::jsonb)
      WHERE id = $1`, [reservation.id]);
    const deniedCancel = await app.inject({ method: 'POST',
      url: `/api/v1/booking/management/${reservation.id}/cancel`, cookies,
      remoteAddress: '198.51.100.32', headers: { 'idempotency-key': randomUUID() } });
    expect(deniedCancel.statusCode).toBe(409);
    expect((await reservationState(reservation.id)).status).toBe('pending_payment');

    const now = await runtime.database.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const early = await runtime.commands.execute<{ anonymized: number }>('booking.reservation.anonymizeExpiredPii', {
      afterId: null, runId: randomUUID(), bucket: Math.floor(now.rows[0]!.now.getTime() / 86_400_000),
      scheduledFor: now.rows[0]!.now.toISOString(),
    }, { actor: SYSTEM_ACTOR, channel: 'worker', idempotencyKey: randomUUID() });
    expect(early.anonymized).toBe(0);
    await expect(runtime.commands.execute('booking.reservation.anonymizeExpiredPii', {
      afterId: 'not-a-uuid', runId: randomUUID(), bucket: 0, scheduledFor: 'invalid',
    }, { actor: SYSTEM_ACTOR, channel: 'worker', idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const stillPrivate = await runtime.database.pool.query<{ booker_email: string; pii_anonymized_at: Date | null }>(
      'SELECT booker_email, pii_anonymized_at FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
    expect(stillPrivate.rows).toEqual([{ booker_email: 'e2e.booker@example.test', pii_anonymized_at: null }]);

    const overdue = new Date(now.rows[0]!.now.getTime() - 1_000).toISOString();
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET payment_expires_at = $2 WHERE id = $1',
      [reservation.id, overdue]);
    const expired = await runtime.commands.execute<{ kind: string }>('booking.reservation.expire', {
      reservationId: reservation.id, expectedPaymentExpiresAt: overdue,
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    expect(expired.kind).toBe('expired');
    expect((await reservationState(reservation.id)).status).toBe('expired');
    expect(await roomNightCounts(input)).toEqual([0, 0]);
  }, 180_000);
});
