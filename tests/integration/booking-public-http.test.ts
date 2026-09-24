import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { signValue, type Keyring } from '@storeweave/crypto';
import { csrfTokenFor } from '@storeweave/identity';
import { resolveKeyring, bindModuleCapability, createMemoryLogger, createRuntime, type CapturedLine, type Runtime } from '@storeweave/kernel';
import type { PaymentCallbackEvent, PaymentProviderV2 } from '@storeweave/extension-sdk';
import {
  bindBookingAvailabilityQuoteReservation, BOOKING_PROPERTY_READ_CAPABILITY,
  createBookingAvailabilityModule, BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  bookingAvailabilityRoomNightOperations,
} from '../../packages/booking/availability/src';
import { bookingPropertyRead, createBookingPropertyModule } from '../../packages/booking/property/src';
import { BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE, createBookingReservationAccess, createBookingReservationModule, type BookingReservationAccess } from '../../packages/booking/reservation/src';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { bookingHttpAdapter } from '../../apps/api/src/releases/booking';
import { SESSION_COOKIE, cookieName } from '../../apps/api/src/http/cookie-names';

const signingSecret = Buffer.alloc(32, 4).toString('base64url');
const callbackSecret = 'booking-http-test-provider-signature';
const manager: Actor = {
  id: 'test:booking-public-http-manager', type: 'user', displayName: 'Booking HTTP manager',
  permissions: ['booking-property:manage', 'booking-availability:manage'],
};
const testProvider: PaymentProviderV2 = {
  id: 'booking-public-http-payment', kind: 'payment',
  paymentMethods: () => [{ code: 'deferred', label: 'Deferred', timing: 'deferred' }],
  initiate: async input => ({ status: 'redirect', providerRef: `private-provider:${input.reference}`,
    action: { type: 'redirect', url: 'https://payments.example.test/continue' } }),
  refund: async () => ({ status: 'succeeded', providerRefundRef: 'unused' }),
  parseCallback: async request => {
    const raw = Buffer.from(request.body);
    const signature = request.headers['x-booking-signature'];
    if (signature !== createHmac('sha256', callbackSecret).update(raw).digest('hex')) throw new Error('Invalid callback signature');
    return JSON.parse(raw.toString('utf8')) as PaymentCallbackEvent;
  },
  acknowledgeCallback: result => ({ body: result.accepted ? 'accepted' : 'retry', statusCode: result.accepted ? 200 : 503 }),
};

function signedCallback(event: PaymentCallbackEvent) {
  const payload = JSON.stringify(event);
  return { method: 'POST' as const, url: `/callbacks/payment/${testProvider.id}`,
    headers: { 'content-type': 'application/json', 'x-booking-signature': createHmac('sha256', callbackSecret).update(payload).digest('hex') }, payload };
}

let container: StartedPostgreSqlContainer;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof createReleaseServer>>;
let roomTypeId: string;
let quoteInput: Record<string, unknown>;
let reservationAccess: BookingReservationAccess;
let keyring: Keyring;
let diagnosticLines: CapturedLine[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog is JSON Schema, so exercise its public response claims against real route output. */
function catalogAccepts(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (Array.isArray(schema.anyOf) && schema.anyOf.some(option => catalogAccepts(option, value))) return true;
  if (Array.isArray(schema.oneOf) && schema.oneOf.some(option => catalogAccepts(option, value))) return true;
  if ('const' in schema && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('null') && value === null) return true;
  if (types.includes('string') && typeof value !== 'string') return false;
  if (types.includes('boolean') && typeof value !== 'boolean') return false;
  if (types.includes('number') && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (types.includes('integer') && (typeof value !== 'number' || !Number.isInteger(value))) return false;
  if (types.includes('array')) {
    return Array.isArray(value) && (!schema.items || value.every(item => catalogAccepts(schema.items, item)));
  }
  if (types.includes('object')) {
    if (!isRecord(value)) return false;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(key => typeof key !== 'string' || !(key in value))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in properties))) return false;
    return Object.entries(value).every(([key, child]) => !(key in properties) || catalogAccepts(properties[key], child));
  }
  return true;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function quoteThenCreate(key: string, checkInOffsetDays = 0) {
  const input = checkInOffsetDays === 0 ? quoteInput : {
    ...quoteInput,
    checkInLocalDate: addDays(quoteInput.checkInLocalDate as string, checkInOffsetDays),
    checkOutLocalDate: addDays(quoteInput.checkOutLocalDate as string, checkInOffsetDays),
  };
  const quote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: input });
  expect(quote.statusCode, quote.body).toBe(201);
  const fingerprint = quote.json().data.quote.fingerprint as string;
  const create = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': key }, payload: {
    quote: { ...input, fingerprint },
    booker: { name: 'Private Booker', email: 'private.booker@example.test', phone: '+1 555 0100' },
    primaryGuestName: 'Private Guest', accommodationNotes: 'Private note',
  } });
  expect(create.statusCode, create.body).toBe(201);
  return { create, payload: {
    quote: { ...input, fingerprint },
    booker: { name: 'Private Booker', email: 'private.booker@example.test', phone: '+1 555 0100' },
    primaryGuestName: 'Private Guest', accommodationNotes: 'Private note',
  } };
}

async function issueGrant(reservationId: string): Promise<string> {
  return (await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, {
    reservationId, ttlMs: 15 * 60_000,
  }))).grantToken;
}

async function registerAccount(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'member-password' } });
  expect(response.statusCode, response.body).toBe(200);
  const session = response.cookies.find(cookie => cookie.name === cookieName(SESSION_COOKIE, 'https://booking.example.test'))!.value;
  return { session, csrf: csrfTokenFor(session) };
}

async function operatorSession(role: 'admin' | 'readonly') {
  const email = `${role}-${randomUUID()}@example.test`;
  const password = 'booking-operator-passphrase';
  await runtime.commands.execute('platform.identity.createUser', { email, password, displayName: role, role },
    { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  expect(login.statusCode, login.body).toBe(200);
  const session = login.cookies.find(cookie => cookie.name === cookieName(SESSION_COOKIE, 'https://booking.example.test'))!.value;
  return { cookies: { [cookieName(SESSION_COOKIE, 'https://booking.example.test')]: session },
    headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': randomUUID() } };
}

async function startHttpPayment(reservationId: string, checkoutCredential: string) {
  const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservationId}/payments`,
    headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
    payload: { method: 'deferred' } });
  expect(payment.statusCode, payment.body).toBe(202);
  const attemptId = payment.json().data.attemptId as string;
  const attempts = await runtime.database.pool.query<{ reference: string }>('SELECT reference FROM booking_reservation_payment_attempts WHERE id = $1', [attemptId]);
  return { attemptId, reference: attempts.rows[0]!.reference };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('booking_public_http').withUsername('booking').withPassword('booking').start();
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-public-http', name: 'Booking public HTTP' },
    http: { publicUrl: 'https://booking.example.test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = { get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? signingSecret : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'] };
  keyring = resolveKeyring(config, secrets)!;
  const diagnostics = createMemoryLogger();
  diagnosticLines = diagnostics.lines;
  const property = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const quoteReservation = bindBookingAvailabilityQuoteReservation(property, { maxRoomsPerRequest: 4 }, keyring);
  const roomNights = bindModuleCapability('booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, bookingAvailabilityRoomNightOperations);
  reservationAccess = createBookingReservationAccess(keyring);
  runtime = await createRuntime({ release: { id: 'booking-public-http', version: '1.0.0', buildManifestChecksum: `sha256:${'4'.repeat(64)}` },
    roles: BASE_ROLES, config, secrets, logger: diagnostics.logger, availableExtensions: {}, modules: [
      createBookingAvailabilityModule(property, { maxRoomsPerRequest: 4 }, keyring), createBookingPropertyModule(),
      createBookingReservationModule(quoteReservation, roomNights, reservationAccess, { reservationPiiRetentionDays: 1 }, testProvider),
    ] });
  runtime.providers.register({ provider: testProvider, owner: 'booking-http-test' });
  await runtime.migrate();
  await runtime.commands.execute('booking.property.create', { name: 'HTTP Test Hotel', address: { countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles', addressLine1: 'Ocean 1', addressLine2: null }, timezone: 'America/Los_Angeles', currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00', defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 } }, { actor: manager, idempotencyKey: randomUUID() });
  const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', { code: 'http', name: 'HTTP room', description: null, maxOccupancyPerUnit: 4, beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null }, { actor: manager, idempotencyKey: randomUUID() });
  roomTypeId = room.id;
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', { roomTypeId, baseNightlyPriceMinor: 12_345 }, { actor: manager, idempotencyKey: randomUUID() });
  const checkInLocalDate = addDays(localDate(new Date()), 7);
  const checkOutLocalDate = addDays(checkInLocalDate, 2);
  await runtime.commands.execute('booking.availability.updateRoomNightRange', { roomTypeId, startLocalDate: checkInLocalDate, endLocalDateExclusive: addDays(checkInLocalDate, 30), sellableUnits: 4 }, { actor: manager, idempotencyKey: randomUUID() });
  quoteInput = { roomTypeId, checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 };
  app = await createReleaseServer({ runtime, httpAdapter: bookingHttpAdapter, release: { version: 'test', configPath: '<test>' } });
}, 120_000);

afterAll(async () => { await app?.close(); await runtime?.close(); await container?.stop(); });

describe('Booking public HTTP checkout credential boundary', () => {
  it('mounts explicit browse/quote/create routes and returns the bearer only on a no-store create response', async () => {
    const property = await app.inject('/api/v1/booking/property');
    const roomTypes = await app.inject('/api/v1/booking/room-types');
    const roomType = await app.inject(`/api/v1/booking/room-types/${roomTypeId}`);
    expect([property.statusCode, roomTypes.statusCode, roomType.statusCode]).toEqual([200, 200, 200]);
    expect(Object.keys(property.json().data)).toEqual(['property']);
    expect(Object.keys(roomTypes.json().data)).toEqual(['items']);
    expect(Object.keys(roomType.json().data)).toEqual(['roomType']);
    const quote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: quoteInput });
    const invalidQuote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: { ...quoteInput, checkInLocalDate: 'not-a-date' } });
    const soldOutQuote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: { ...quoteInput, adults: 4, roomCount: 4 } });
    const search = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes/search', payload: {
      checkInLocalDate: quoteInput.checkInLocalDate, checkOutLocalDate: quoteInput.checkOutLocalDate,
      adults: quoteInput.adults, children: quoteInput.children, roomCount: quoteInput.roomCount,
    } });
    expect([quote.statusCode, invalidQuote.statusCode, soldOutQuote.statusCode, search.statusCode]).toEqual([201, 400, 201, 201]);
    const catalog = (app.getHttpAdapter().getInstance() as { storeweaveHttpCatalog?: Array<{ path: string; output: unknown }> }).storeweaveHttpCatalog!;
    const bookingRoutes = catalog.filter(route => route.path.startsWith('/api/v1/booking'));
    const callbackRoutes = catalog.filter(route => route.path.startsWith('/callbacks/'));
    expect(callbackRoutes).toHaveLength(1);
    expect(callbackRoutes[0]?.path).toBe('/callbacks/:kind/:providerId');
    expect(bookingRoutes).toHaveLength(30);
    const operatorRoutes = bookingRoutes.filter(route => route.path.startsWith('/api/v1/booking/operator/')) as unknown as Array<{
      auth: string; owner: string | null; permission: unknown; target: { kind: string; name: string } | null;
      idempotencyKey: string;
    }>;
    expect(operatorRoutes).toHaveLength(17);
    for (const route of operatorRoutes) {
      expect(route.auth).toBe('session');
      expect(route.owner).toEqual(expect.any(String));
      expect(route.permission).not.toBeNull();
      expect(route.target?.name).toMatch(/^booking\./);
      expect(route.idempotencyKey).toBe(route.target?.kind === 'command' ? 'request-header' : 'none');
    }
    expect(bookingRoutes.map(route => route.path).sort()).toEqual([
      '/api/v1/booking/management/:reservationId', '/api/v1/booking/management/:reservationId',
      '/api/v1/booking/management/:reservationId/cancel', '/api/v1/booking/management/:reservationId/claim',
      '/api/v1/booking/management/:reservationId/grants', '/api/v1/booking/management/:reservationId/resend-access-grant',
      '/api/v1/booking/operator/availability/base-price', '/api/v1/booking/operator/availability/room-night-range',
      '/api/v1/booking/operator/availability/room-night-range', '/api/v1/booking/operator/property',
      '/api/v1/booking/operator/property', '/api/v1/booking/operator/property',
      '/api/v1/booking/operator/refunds/retry', '/api/v1/booking/operator/reservations',
      '/api/v1/booking/operator/reservations/:reservationId',
      '/api/v1/booking/operator/reservations/:reservationId/notifications',
      '/api/v1/booking/operator/reservations/:reservationId/payment-attempts',
      '/api/v1/booking/operator/reservations/:reservationId/refunds',
      '/api/v1/booking/operator/reservations/cancel',
      '/api/v1/booking/operator/room-types', '/api/v1/booking/operator/room-types',
      '/api/v1/booking/operator/room-types', '/api/v1/booking/operator/room-types/:roomTypeId',
      '/api/v1/booking/property', '/api/v1/booking/quotes', '/api/v1/booking/quotes/search',
      '/api/v1/booking/reservations', '/api/v1/booking/reservations/:reservationId/payments',
      '/api/v1/booking/room-types', '/api/v1/booking/room-types/:roomTypeId',
    ]);
    expect(JSON.stringify(bookingRoutes.map(route => route.output))).not.toContain('"additionalProperties":true');
    const outputFor = (path: string) => bookingRoutes.find(route => route.path === path)!.output;
    for (const [path, response] of [
      ['/api/v1/booking/property', property],
      ['/api/v1/booking/room-types', roomTypes],
      ['/api/v1/booking/room-types/:roomTypeId', roomType],
      ['/api/v1/booking/quotes', quote],
      ['/api/v1/booking/quotes/search', search],
    ] as const) expect(catalogAccepts(outputFor(path), response.json())).toBe(true);
    const key = '11111111-1111-4111-8111-111111111111';
    const { create, payload } = await quoteThenCreate(key);
    expect(create.headers['cache-control']).toBe('no-store');
    const body = create.json().data as { reservation: { id: string }; checkoutCredential: string; checkoutCredentialExpiresAt: string };
    expect(body.checkoutCredential).toMatch(/^brc1\./);
    expect(body.checkoutCredentialExpiresAt).toEqual(expect.any(String));
    expect(JSON.stringify(body.reservation)).not.toContain(body.checkoutCredential);
    expect(catalogAccepts(outputFor('/api/v1/booking/reservations'), create.json())).toBe(true);
    const soldOut = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': randomUUID() }, payload: {
      ...payload,
      quote: { ...quoteInput, adults: 4, roomCount: 4, fingerprint: soldOutQuote.json().data.quote.fingerprint },
    } });
    expect(soldOut.statusCode, soldOut.body).toBe(409);
    expect(soldOut.json().data).toEqual({ kind: 'unavailable' });
    expect(catalogAccepts(outputFor('/api/v1/booking/reservations'), soldOut.json())).toBe(true);
    const stored = await runtime.database.pool.query<{ row: unknown }>('SELECT row_to_json(r) AS row FROM booking_reservation_reservations r WHERE id = $1', [body.reservation.id]);
    expect(JSON.stringify(stored.rows[0]?.row)).not.toContain(body.checkoutCredential);
    const issuedClientCookie = create.cookies.find(cookie => cookie.name === '__Host-booking_public_client')!;
    expect(issuedClientCookie).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(issuedClientCookie.domain).toBeUndefined();
    const clientCookie = issuedClientCookie.value;
    const replay = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', cookies: { '__Host-booking_public_client': clientCookie }, headers: { 'idempotency-key': key }, payload });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().data.checkoutCredential).toBe(body.checkoutCredential);
    // A subdomain can set the bare name. It must neither select the original
    // namespace nor turn a shared caller UUID into a credential replay.
    const victimQuote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: quoteInput });
    expect(victimQuote.statusCode, victimQuote.body).toBe(201);
    const victimPayload = { ...payload, quote: { ...quoteInput, fingerprint: victimQuote.json().data.quote.fingerprint } };
    const preclaim = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', cookies: { booking_public_client: clientCookie }, headers: { 'idempotency-key': key }, payload: victimPayload });
    expect(preclaim.statusCode, preclaim.body).toBe(201);
    expect(preclaim.json().data.checkoutCredential).not.toBe(body.checkoutCredential);
    expect(preclaim.cookies.find(cookie => cookie.name === '__Host-booking_public_client')!.value).not.toBe(clientCookie);
    expect(catalogAccepts(outputFor('/api/v1/booking/reservations'), preclaim.json())).toBe(true);
    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', { roomTypeId, baseNightlyPriceMinor: 13_000 }, { actor: manager, idempotencyKey: randomUUID() });
    const stale = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': randomUUID() }, payload: victimPayload });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(catalogAccepts(outputFor('/api/v1/booking/reservations'), stale.json())).toBe(true);
    const secretSurfaces = await runtime.database.pool.query<{ payload: unknown }>(`
      SELECT response AS payload FROM platform_idempotency
      UNION ALL SELECT payload FROM platform_audit_log
      UNION ALL SELECT payload FROM platform_jobs
      UNION ALL SELECT payload FROM platform_outbox
    `);
    expect(JSON.stringify(secretSurfaces.rows)).not.toContain(body.checkoutCredential);
    const invalidKey = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': 'predictable' }, payload });
    expect(invalidKey.statusCode).toBe(400);
    for (const invalidVersion of ['00000000-0000-0000-0000-000000000000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) {
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': invalidVersion }, payload });
      expect(invalid.statusCode).toBe(400);
    }
  });

  it('treats all checkout authorization failures alike before payment method lookup and exposes no provider secret', async () => {
    const first = (await quoteThenCreate(randomUUID())).create;
    const second = (await quoteThenCreate(randomUUID())).create;
    const firstData = first.json().data as { reservation: { id: string }; checkoutCredential: string };
    const secondData = second.json().data as { reservation: { id: string }; checkoutCredential: string };
    const request = (
      id: string,
      credential: string | undefined,
      method = 'not-a-real-method',
      idempotencyKey = randomUUID(),
      cookies?: Record<string, string>,
    ) => app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${id}/payments`, cookies, headers: credential ? { 'x-booking-checkout-credential': credential, 'idempotency-key': idempotencyKey } : { 'idempotency-key': idempotencyKey }, payload: { method } });
    const [missing, malformed, cross] = await Promise.all([
      request(firstData.reservation.id, undefined), request(firstData.reservation.id, 'brc1.not-valid'), request(firstData.reservation.id, secondData.checkoutCredential),
    ]);
    expect([missing.statusCode, malformed.statusCode, cross.statusCode]).toEqual([401, 401, 401]);
    expect([missing.json(), malformed.json(), cross.json()]).toEqual([missing.json(), missing.json(), missing.json()]);
    const unauthorizedAttempts = await runtime.database.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM booking_reservation_payment_attempts WHERE reservation_id = $1', [firstData.reservation.id]);
    expect(unauthorizedAttempts.rows).toEqual([{ count: '0' }]);
    const paid = await request(firstData.reservation.id, firstData.checkoutCredential, 'deferred');
    expect(paid.statusCode, paid.body).toBe(202);
    expect(paid.json().data).toEqual({ attemptId: expect.any(String), status: expect.any(String), expiresAt: expect.any(String) });
    expect(JSON.stringify(paid.json())).not.toMatch(/private-provider|providerRef|reference/i);
    const replayKey = randomUUID();
    const secondClientCookie = second.cookies.find(cookie => cookie.name === '__Host-booking_public_client')!.value;
    const replayCookies = { '__Host-booking_public_client': secondClientCookie };
    const replayable = await request(secondData.reservation.id, secondData.checkoutCredential, 'deferred', replayKey, replayCookies);
    expect(replayable.statusCode, replayable.body).toBe(202);
    const replayAttemptId = replayable.json().data.attemptId as string;
    const replayAttempt = await runtime.database.pool.query<{ reference: string }>(
      'SELECT reference FROM booking_reservation_payment_attempts WHERE id = $1', [replayAttemptId],
    );
    await runtime.commands.execute('booking.reservation.recordVerifiedPaymentOutcome', {
      provider: testProvider.id,
      event: { type: 'payment_confirmed', reference: replayAttempt.rows[0]!.reference, providerRef: `confirmed:${replayAttemptId}` },
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    const revokedReplay = await request(secondData.reservation.id, secondData.checkoutCredential, 'deferred', replayKey, replayCookies);
    expect(revokedReplay.statusCode, revokedReplay.body).toBe(401);
    const badPaymentIdempotency = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${firstData.reservation.id}/payments`, headers: { 'x-booking-checkout-credential': firstData.checkoutCredential, 'idempotency-key': 'predictable' }, payload: { method: 'deferred' } });
    expect(badPaymentIdempotency.statusCode).toBe(400);
  });
});

describe('Booking operator HTTP boundary', () => {
  it('authorizes human Reservation reads and evidence without exposing the list PII to a reader or service token', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 5);
    const reservationId = create.json().data.reservation.id as string;
    const admin = await operatorSession('admin');
    const list = await app.inject({ url: '/api/v1/booking/operator/reservations?limit=2&offset=0', cookies: admin.cookies });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: reservationId })]));
    expect(JSON.stringify(list.json())).not.toContain('private.booker@example.test');
    const detail = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservationId}`, cookies: admin.cookies });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.reservation).toMatchObject({ id: reservationId, booker: { email: 'private.booker@example.test' } });
    for (const suffix of ['payment-attempts', 'refunds', 'notifications']) {
      const evidence = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservationId}/${suffix}`, cookies: admin.cookies });
      expect(evidence.statusCode, evidence.body).toBe(200);
      expect(evidence.json().data).toEqual({ items: [], total: 0 });
      const unknown = await app.inject({ url: `/api/v1/booking/operator/reservations/${randomUUID()}/${suffix}`, cookies: admin.cookies });
      expect(unknown.statusCode, unknown.body).toBe(404);
    }
    expect((await app.inject({ url: '/api/v1/booking/operator/reservations?limit=101', cookies: admin.cookies })).statusCode).toBe(400);
    const reader = await operatorSession('readonly');
    expect((await app.inject({ url: '/api/v1/booking/operator/reservations', cookies: reader.cookies })).statusCode).toBe(403);
    const token = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx, { name: `booking-http-${randomUUID()}`, role: 'admin', ttlMs: 60_000 }));
    expect((await app.inject({ url: '/api/v1/booking/operator/reservations', headers: { authorization: `Bearer ${token.secret}` } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/booking/operator/reservations/${randomUUID()}`, cookies: admin.cookies })).statusCode).toBe(404);
  });

  it('routes Property and Availability writes through operator authorization and validates refund input', async () => {
    const admin = await operatorSession('admin');
    const property = await app.inject({ url: '/api/v1/booking/operator/property', cookies: admin.cookies });
    expect(property.statusCode, property.body).toBe(200);
    expect(property.json().data.property.name).toBe('HTTP Test Hotel');
    const range = await app.inject({ url: `/api/v1/booking/operator/availability/room-night-range?roomTypeId=${roomTypeId}&startLocalDate=${quoteInput.checkInLocalDate}&endLocalDateExclusive=${quoteInput.checkOutLocalDate}`, cookies: admin.cookies });
    expect(range.statusCode, range.body).toBe(200);
    expect(range.json().data.nights).toHaveLength(2);
    const price = await app.inject({ method: 'PUT', url: '/api/v1/booking/operator/availability/base-price', cookies: admin.cookies, headers: admin.headers,
      payload: { roomTypeId, baseNightlyPriceMinor: 13_000 } });
    expect(price.statusCode, price.body).toBe(200);
    const invalidRefund = await app.inject({ method: 'POST', url: '/api/v1/booking/operator/refunds/retry', cookies: admin.cookies, headers: admin.headers,
      payload: { refundId: 'not-a-uuid' } });
    expect(invalidRefund.statusCode).toBe(400);
    const reader = await operatorSession('readonly');
    expect((await app.inject({ method: 'PUT', url: '/api/v1/booking/operator/availability/base-price', cookies: reader.cookies, headers: reader.headers,
      payload: { roomTypeId, baseNightlyPriceMinor: 14_000 } })).statusCode).toBe(403);
  });

  it('authorizes direct Property and Room Type operator URLs and rejects invalid facts', async () => {
    const admin = await operatorSession('admin');
    const reader = await operatorSession('readonly');
    const propertyUrl = '/api/v1/booking/operator/property';
    const roomsUrl = '/api/v1/booking/operator/room-types';
    const existingProperty = (await app.inject({ url: propertyUrl, cookies: admin.cookies })).json().data.property;
    const existingRoom = (await app.inject({ url: `${roomsUrl}/${roomTypeId}`, cookies: admin.cookies })).json().data;
    const { id: _propertyId, createdAt: _propertyCreatedAt, updatedAt: _propertyUpdatedAt, ...propertyFacts } = existingProperty;
    const { id: _roomId, status: _roomStatus, createdAt: _roomCreatedAt, updatedAt: _roomUpdatedAt, ...roomFacts } = existingRoom;
    const { code: _roomCode, ...roomUpdateFacts } = roomFacts;

    for (const url of [propertyUrl, roomsUrl, `${roomsUrl}/${roomTypeId}`]) {
      expect((await app.inject({ url, cookies: reader.cookies })).statusCode, url).toBe(403);
    }
    for (const request of [
      { method: 'POST' as const, url: propertyUrl, payload: propertyFacts },
      { method: 'PUT' as const, url: propertyUrl, payload: propertyFacts },
      { method: 'POST' as const, url: roomsUrl, payload: roomFacts },
      { method: 'PUT' as const, url: roomsUrl, payload: { ...roomUpdateFacts, status: existingRoom.status, roomTypeId } },
    ]) {
      const response = await app.inject({ ...request, cookies: reader.cookies,
        headers: { ...reader.headers, 'idempotency-key': randomUUID() } });
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(403);
    }

    expect((await app.inject({ method: 'POST', url: propertyUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: propertyFacts })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: propertyUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: { ...propertyFacts, timezone: 'Mars/Olympus' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: roomsUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: roomFacts })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: roomsUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: { ...roomFacts,
        code: `new-${randomUUID()}`, maxOccupancyPerUnit: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: roomsUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: { ...roomFacts,
        code: `new-${randomUUID()}`, mediaAssetId: randomUUID() } })).statusCode).toBe(400);
    expect((await app.inject({ url: `${roomsUrl}/${randomUUID()}`, cookies: admin.cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: roomsUrl, cookies: admin.cookies,
      headers: { ...admin.headers, 'idempotency-key': randomUUID() },
      payload: { ...roomUpdateFacts, status: existingRoom.status, roomTypeId: randomUUID() } })).statusCode).toBe(404);
  });
});

describe('Booking payment callback HTTP boundary', () => {
  it('rejects unverified and unknown results, then acknowledges a verified duplicate without repeating confirmation', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 6);
    const { reservation, checkoutCredential } = create.json().data as { reservation: { id: string }; checkoutCredential: string };
    const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'deferred' } });
    expect(payment.statusCode, payment.body).toBe(202);
    const attemptId = payment.json().data.attemptId as string;
    const attempts = await runtime.database.pool.query<{ reference: string }>('SELECT reference FROM booking_reservation_payment_attempts WHERE id = $1', [attemptId]);
    const event: PaymentCallbackEvent = { type: 'payment_confirmed', reference: attempts.rows[0]!.reference, providerRef: `confirmed:${attemptId}` };
    const signed = signedCallback(event);
    const injectedCredential = 'v1.1.private-management-credential';
    const tampered = await app.inject({ ...signed, headers: { ...signed.headers, 'x-booking-signature': 'bad', 'x-correlation-id': injectedCredential } });
    expect(tampered.statusCode, tampered.body).toBe(503);
    expect(tampered.body).toBe('retry');
    const unknown = await app.inject(signedCallback({ ...event, reference: 'unknown-provider-reference' }));
    expect(unknown.statusCode, unknown.body).toBe(503);
    const malformedPayload = '{"type":';
    const malformed = await app.inject({ method: 'POST', url: `/callbacks/payment/${testProvider.id}`,
      headers: { 'content-type': 'application/json', 'x-booking-signature': createHmac('sha256', callbackSecret).update(malformedPayload).digest('hex') },
      payload: malformedPayload });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/callbacks/shipping/${testProvider.id}`, payload: '' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/callbacks/payment/${testProvider.id}` })).statusCode).toBe(404);
    const before = await runtime.database.pool.query<{ status: string }>('SELECT status FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
    expect(before.rows[0]?.status).toBe('pending_payment');
    const first = await app.inject(signed);
    const replay = await app.inject(signed);
    expect([first.statusCode, replay.statusCode]).toEqual([200, 200]);
    expect([first.body, replay.body]).toEqual(['accepted', 'accepted']);
    const admin = await operatorSession('admin');
    const detail = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}`, cookies: admin.cookies });
    const evidence = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}/payment-attempts`, cookies: admin.cookies });
    expect(detail.json().data.reservation.status).toBe('confirmed');
    expect(evidence.json().data.items).toEqual([expect.objectContaining({ id: attemptId, successKind: 'winning' })]);
    const logs = JSON.stringify(diagnosticLines);
    expect(logs).not.toContain(checkoutCredential);
    expect(logs).not.toContain(injectedCredential);
    expect(logs).not.toContain('private.booker@example.test');
    expect(logs).not.toContain(signed.payload);
  });

  it('keeps a cancelled Reservation free when a verified payment arrives late', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 10);
    const { reservation, checkoutCredential } = create.json().data as { reservation: { id: string }; checkoutCredential: string };
    const attempt = await startHttpPayment(reservation.id, checkoutCredential);
    const admin = await operatorSession('admin');
    const cancellation = await app.inject({ method: 'POST', url: '/api/v1/booking/operator/reservations/cancel', cookies: admin.cookies,
      headers: admin.headers, payload: { reservationId: reservation.id, refundAmountMinor: 0, reason: 'operator cancellation' } });
    expect(cancellation.statusCode, cancellation.body).toBe(201);
    const before = await runtime.database.pool.query<{ reserved_units: number }>(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2',
      [roomTypeId, addDays(quoteInput.checkInLocalDate as string, 10)]);
    const callback = await app.inject(signedCallback({ type: 'payment_confirmed', reference: attempt.reference, providerRef: `late:${attempt.attemptId}` }));
    expect(callback.statusCode, callback.body).toBe(200);
    const detail = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}`, cookies: admin.cookies });
    const payments = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}/payment-attempts`, cookies: admin.cookies });
    const refunds = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}/refunds`, cookies: admin.cookies });
    expect(detail.json().data.reservation.status).toBe('cancelled');
    expect(payments.json().data.items).toEqual([expect.objectContaining({ id: attempt.attemptId, successKind: 'late' })]);
    expect(refunds.json().data.items).toEqual([expect.objectContaining({ reason: 'late_payment' })]);
    const after = await runtime.database.pool.query<{ reserved_units: number }>(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2',
      [roomTypeId, addDays(quoteInput.checkInLocalDate as string, 10)]);
    expect(after.rows).toEqual(before.rows);
  });

  it('keeps one winning Reservation allocation when an earlier attempt succeeds in excess', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 12);
    const { reservation, checkoutCredential } = create.json().data as { reservation: { id: string }; checkoutCredential: string };
    const first = await startHttpPayment(reservation.id, checkoutCredential);
    expect((await app.inject(signedCallback({ type: 'payment_failed', reference: first.reference, providerRef: `failed:${first.attemptId}`, message: 'declined' }))).statusCode).toBe(200);
    const second = await startHttpPayment(reservation.id, checkoutCredential);
    expect((await app.inject(signedCallback({ type: 'payment_confirmed', reference: second.reference, providerRef: `winning:${second.attemptId}` }))).statusCode).toBe(200);
    const before = await runtime.database.pool.query<{ reserved_units: number }>(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2',
      [roomTypeId, addDays(quoteInput.checkInLocalDate as string, 12)]);
    expect((await app.inject(signedCallback({ type: 'payment_confirmed', reference: first.reference, providerRef: `excess:${first.attemptId}` }))).statusCode).toBe(200);
    const admin = await operatorSession('admin');
    const detail = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}`, cookies: admin.cookies });
    const payments = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}/payment-attempts`, cookies: admin.cookies });
    const refunds = await app.inject({ url: `/api/v1/booking/operator/reservations/${reservation.id}/refunds`, cookies: admin.cookies });
    expect(detail.json().data.reservation.status).toBe('confirmed');
    expect(payments.json().data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.attemptId, successKind: 'excess' }),
      expect.objectContaining({ id: second.attemptId, successKind: 'winning' }),
    ]));
    expect(refunds.json().data.items).toEqual([expect.objectContaining({ reason: 'excess_payment' })]);
    const after = await runtime.database.pool.query<{ reserved_units: number }>(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2',
      [roomTypeId, addDays(quoteInput.checkInLocalDate as string, 12)]);
    expect(after.rows).toEqual(before.rows);
  });
});

describe('Booking Reservation management HTTP boundary', () => {
  async function redeem(reservationId: string, grant: string, remoteAddress: string) {
    return app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}/grants?grantToken=${encodeURIComponent(grant)}`, remoteAddress });
  }

  function managementCookies(response: Awaited<ReturnType<typeof redeem>>) {
    const value = response.cookies.find(cookie => cookie.name === '__Host-booking_reservation_management')?.value;
    expect(value).toEqual(expect.any(String));
    return { '__Host-booking_reservation_management': value! };
  }

  it('redeems a Grant into a clean, host-only management session and permits only its scoped Reservation', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 3);
    const reservationId = (create.json().data as { reservation: { id: string } }).reservation.id;
    const grant = await issueGrant(reservationId);
    const redeemed = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}/grants?grantToken=${encodeURIComponent(grant)}`, remoteAddress: '198.51.100.10' });
    expect(redeemed.statusCode, redeemed.body).toBe(303);
    expect(redeemed.headers.location).toBe(`/api/v1/booking/management/${reservationId}`);
    expect(redeemed.headers.location).not.toContain(grant);
    expect(redeemed.headers['cache-control']).toBe('no-store');
    const management = redeemed.cookies.find(cookie => cookie.name === '__Host-booking_reservation_management')!;
    expect(management).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(management.domain).toBeUndefined();
    const cookies = { '__Host-booking_reservation_management': management.value };

    const replay = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}/grants?grantToken=${encodeURIComponent(grant)}`, remoteAddress: '198.51.100.10' });
    expect(replay.statusCode).toBe(401);
    expect(replay.body).not.toContain(grant);

    const read = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}`, cookies, remoteAddress: '198.51.100.10' });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json().data.reservation).toMatchObject({ id: reservationId, booker: { email: 'private.booker@example.test' } });
    expect(JSON.stringify(read.json())).not.toContain(management.value);

    const updateKey = randomUUID();
    const updated = await app.inject({
      method: 'PATCH', url: `/api/v1/booking/management/${reservationId}`, cookies, remoteAddress: '198.51.100.10',
      headers: { 'idempotency-key': updateKey }, payload: { primaryGuestName: 'Updated Guest' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data).toEqual({ reservationId, updatedFields: ['primaryGuestName'] });
    expect(JSON.stringify(updated.json())).not.toContain(management.value);

    const resendKey = randomUUID();
    const resent = await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/resend-access-grant`, cookies, remoteAddress: '198.51.100.10', headers: { 'idempotency-key': resendKey } });
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json().data).toEqual({ reservationId, accepted: true });
    expect(JSON.stringify(resent.json())).not.toMatch(/grant|credential|private\.booker@example\.test/i);
    // Resend rotates the access generation and invalidates the just-used cookie.
    // Its mandatory transaction-bound guard runs before an idempotency replay,
    // so an old acknowledgement cannot be replayed after revocation.
    expect((await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/resend-access-grant`, cookies, remoteAddress: '198.51.100.10', headers: { 'idempotency-key': resendKey } })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'PATCH', url: `/api/v1/booking/management/${reservationId}`, cookies, remoteAddress: '198.51.100.10',
      headers: { 'idempotency-key': updateKey }, payload: { primaryGuestName: 'Updated Guest' },
    })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}`, cookies, remoteAddress: '198.51.100.10' })).statusCode).toBe(401);
  });

  it('requires same-origin protection for anonymous management writes, then cancels the whole Reservation', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 6);
    const reservationId = (create.json().data as { reservation: { id: string } }).reservation.id;
    const grant = await issueGrant(reservationId);
    const redeemed = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}/grants?grantToken=${encodeURIComponent(grant)}`, remoteAddress: '198.51.100.11' });
    const cookie = redeemed.cookies.find(value => value.name === '__Host-booking_reservation_management')!.value;
    const cookies = { '__Host-booking_reservation_management': cookie };
    const key = randomUUID();
    const crossSite = await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/cancel`, cookies, remoteAddress: '198.51.100.11', headers: { origin: 'https://attacker.example.test', 'idempotency-key': key } });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.body).not.toContain(cookie);
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/cancel`, cookies, remoteAddress: '198.51.100.11', headers: { 'idempotency-key': key } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().data).toMatchObject({ reservationId, cancelled: true, refund: null });
    const resent = await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/resend-access-grant`, cookies, remoteAddress: '198.51.100.11', headers: { 'idempotency-key': randomUUID() } });
    expect(resent.statusCode, resent.body).toBe(200);
    // The cancellation response is durable, but its old capability must be
    // checked before idempotency can replay it.
    expect((await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/cancel`, cookies, remoteAddress: '198.51.100.11', headers: { 'idempotency-key': key } })).statusCode).toBe(401);
  });

  it('never infers ownership from matching Booker Email and requires both re-login and management proof to claim', async () => {
    const { create } = await quoteThenCreate(randomUUID(), 9);
    const reservationId = (create.json().data as { reservation: { id: string } }).reservation.id;
    const grant = await issueGrant(reservationId);
    const redeemed = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}/grants?grantToken=${encodeURIComponent(grant)}`, remoteAddress: '198.51.100.12' });
    const management = redeemed.cookies.find(cookie => cookie.name === '__Host-booking_reservation_management')!.value;
    const account = await registerAccount('private.booker@example.test');
    const sessionCookies = { '__Host-commerce_session': account.session };
    const nonOwner = await registerAccount('not-the-booker@example.test');

    const emailMatchOnly = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${reservationId}`, cookies: sessionCookies, remoteAddress: '198.51.100.12' });
    expect(emailMatchOnly.statusCode).toBe(404);
    const nonOwnerWithManagement = await app.inject({
      method: 'GET', url: `/api/v1/booking/management/${reservationId}`, remoteAddress: '198.51.100.12',
      cookies: { '__Host-commerce_session': nonOwner.session, '__Host-booking_reservation_management': management },
    });
    expect(nonOwnerWithManagement.statusCode, nonOwnerWithManagement.body).toBe(200);
    const missingManagement = await app.inject({ method: 'POST', url: `/api/v1/booking/management/${reservationId}/claim`, cookies: sessionCookies, remoteAddress: '198.51.100.12', headers: { 'x-csrf-token': account.csrf, 'idempotency-key': randomUUID() } });
    expect(missingManagement.statusCode).toBe(401);

    const claimed = await app.inject({
      method: 'POST', url: `/api/v1/booking/management/${reservationId}/claim`, remoteAddress: '198.51.100.12',
      cookies: { ...sessionCookies, '__Host-booking_reservation_management': management },
      headers: { 'x-csrf-token': account.csrf, 'idempotency-key': randomUUID() }, payload: { accountId: randomUUID() },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().data).toEqual({ reservationId, kind: 'claimed' });

    const ownerResend = await app.inject({
      method: 'POST', url: `/api/v1/booking/management/${reservationId}/resend-access-grant`, remoteAddress: '198.51.100.12',
      cookies: { ...sessionCookies, '__Host-booking_reservation_management': management },
      headers: { 'x-csrf-token': account.csrf, 'idempotency-key': randomUUID() },
    });
    expect(ownerResend.statusCode, ownerResend.body).toBe(200);
    const owned = await app.inject({
      method: 'GET', url: `/api/v1/booking/management/${reservationId}`, remoteAddress: '198.51.100.12',
      cookies: { ...sessionCookies, '__Host-booking_reservation_management': management },
    });
    expect(owned.statusCode, owned.body).toBe(200);
    expect(owned.json().data.reservation.id).toBe(reservationId);
  });

  it('declares and enforces the auth rate-limit bucket on every management route, including GET', async () => {
    const catalog = (app.getHttpAdapter().getInstance() as { storeweaveHttpCatalog?: Array<{ path: string; rateLimit: string | null }> }).storeweaveHttpCatalog!;
    const managementRoutes = catalog.filter(route => route.path.startsWith('/api/v1/booking/management'));
    expect(managementRoutes).toHaveLength(6);
    expect(managementRoutes.map(route => route.rateLimit)).toEqual(Array(6).fill('auth'));

    const reservationId = randomUUID();
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(await app.inject({
        method: 'GET', url: `/api/v1/booking/management/${reservationId}`,
        cookies: { '__Host-booking_reservation_management': 'not-a-management-credential' }, remoteAddress: '198.51.100.13',
      }));
    }
    expect(responses.slice(0, 10).map(response => response.statusCode)).toEqual(Array(10).fill(401));
    expect(responses[10]!.statusCode).toBe(429);
    expect(responses[10]!.headers['retry-after']).toEqual(expect.any(String));
  });

  it('does not consume a valid Grant addressed to another Reservation and rejects expired or rotated Grants', async () => {
    const first = (await quoteThenCreate(randomUUID(), 12)).create.json().data.reservation.id as string;
    const second = (await quoteThenCreate(randomUUID(), 15)).create.json().data.reservation.id as string;
    const grant = await issueGrant(first);
    const wrong = await redeem(second, grant, '198.51.100.14');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(wrong.body).not.toContain(grant);
    const valid = await redeem(first, grant, '198.51.100.14');
    expect(valid.statusCode, valid.body).toBe(303);
    const cookies = managementCookies(valid);
    expect((await app.inject({ method: 'GET', url: `/api/v1/booking/management/${first}`, cookies, remoteAddress: '198.51.100.14' })).statusCode).toBe(200);
    const missingSession = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${first}`, remoteAddress: '198.51.100.14' });
    const wrongSession = await app.inject({ method: 'GET', url: `/api/v1/booking/management/${second}`, cookies, remoteAddress: '198.51.100.14' });
    expect([missingSession.statusCode, wrongSession.statusCode]).toEqual([401, 401]);
    expect(wrongSession.body).not.toContain('private.booker@example.test');

    const revoked = await issueGrant(second);
    await issueGrant(second);
    const rotated = await redeem(second, revoked, '198.51.100.15');
    expect(rotated.statusCode).toBe(401);
    expect(rotated.headers['set-cookie']).toBeUndefined();

    const expiring = await runtime.database.transaction(tx => reservationAccess.issueGrant(tx, { reservationId: second, ttlMs: 15 * 60_000 }));
    const state = await runtime.database.pool.query<{ access_grant_nonce: string }>(
      'SELECT access_grant_nonce FROM booking_reservation_reservations WHERE id = $1', [second],
    );
    const expiredAt = new Date(Math.floor((Date.now() - 5_000) / 1_000) * 1_000);
    const expiredToken = signValue(keyring, {
      purpose: BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
      payload: JSON.stringify({ version: 1, reservationId: second, generation: expiring.generation, nonce: state.rows[0]!.access_grant_nonce }),
      expiresAt: expiredAt,
    });
    await runtime.database.pool.query('UPDATE booking_reservation_reservations SET access_grant_expires_at = $2 WHERE id = $1', [second, expiredAt]);
    const expired = await redeem(second, expiredToken, '198.51.100.15');
    expect(expired.statusCode).toBe(401);
    expect(expired.headers['set-cookie']).toBeUndefined();
    expect(expired.body).not.toContain(expiredToken);
  });

  it('rejects non-owner Account writes and keeps immutable facts and invalid contact out of updates', async () => {
    const reservationId = (await quoteThenCreate(randomUUID(), 18)).create.json().data.reservation.id as string;
    const grant = await issueGrant(reservationId);
    const redeemed = await redeem(reservationId, grant, '198.51.100.16');
    const cookies = managementCookies(redeemed);
    const stranger = await registerAccount('management-stranger@example.test');
    const strangerCookies = { '__Host-commerce_session': stranger.session };
    const url = `/api/v1/booking/management/${reservationId}`;
    const denied = await app.inject({ method: 'PATCH', url, cookies: strangerCookies, remoteAddress: '198.51.100.16', headers: { 'x-csrf-token': stranger.csrf, 'idempotency-key': randomUUID() }, payload: { primaryGuestName: 'Intruder' } });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain('private.booker@example.test');
    const deniedCancel = await app.inject({ method: 'POST', url: `${url}/cancel`, cookies: strangerCookies, remoteAddress: '198.51.100.16', headers: { 'x-csrf-token': stranger.csrf, 'idempotency-key': randomUUID() } });
    expect(deniedCancel.statusCode).toBe(404);
    const deniedResend = await app.inject({ method: 'POST', url: `${url}/resend-access-grant`, cookies: strangerCookies, remoteAddress: '198.51.100.16', headers: { 'x-csrf-token': stranger.csrf, 'idempotency-key': randomUUID() } });
    expect(deniedResend.statusCode).toBe(404);

    const immutable = await app.inject({ method: 'PATCH', url, cookies, remoteAddress: '198.51.100.16', headers: { 'idempotency-key': randomUUID() }, payload: { roomTypeId, primaryGuestName: 'Should Not Change' } });
    expect(immutable.statusCode).toBe(400);
    const invalidContact = await app.inject({ method: 'PATCH', url, cookies, remoteAddress: '198.51.100.16', headers: { 'idempotency-key': randomUUID() }, payload: { booker: { name: 'Valid', email: 'not-an-email', phone: '+1 555 0100' } } });
    expect(invalidContact.statusCode).toBe(400);
    const read = await app.inject({ method: 'GET', url, cookies, remoteAddress: '198.51.100.16' });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.reservation.primaryGuestName).toBe('Private Guest');
    expect(read.json().data.reservation.booker.email).toBe('private.booker@example.test');
    expect(JSON.stringify(read.json())).not.toContain(cookies['__Host-booking_reservation_management']);
  });

  it('enforces the frozen cancellation deadline and leaves the Reservation active', async () => {
    const reservationId = (await quoteThenCreate(randomUUID(), 21)).create.json().data.reservation.id as string;
    const grant = await issueGrant(reservationId);
    const cookies = managementCookies(await redeem(reservationId, grant, '198.51.100.17'));
    await runtime.database.pool.query(`UPDATE booking_reservation_reservations
      SET cancellation_policy = jsonb_set(cancellation_policy, '{freeCancellationHoursBeforeCheckIn}', '8760'::jsonb)
      WHERE id = $1`, [reservationId]);
    const url = `/api/v1/booking/management/${reservationId}`;
    const refused = await app.inject({ method: 'POST', url: `${url}/cancel`, cookies, remoteAddress: '198.51.100.17', headers: { 'idempotency-key': randomUUID() } });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatch(/deadline/i);
    expect(refused.body).not.toContain(cookies['__Host-booking_reservation_management']);
    const read = await app.inject({ method: 'GET', url, cookies, remoteAddress: '198.51.100.17' });
    expect(read.json().data.reservation.status).toBe('pending_payment');
  });

  it('requires session CSRF on PATCH, resend, and claim, and rejects cross-origin anonymous writes', async () => {
    const reservationId = (await quoteThenCreate(randomUUID(), 24)).create.json().data.reservation.id as string;
    const grant = await issueGrant(reservationId);
    const management = managementCookies(await redeem(reservationId, grant, '198.51.100.18'));
    const account = await registerAccount('csrf-management@example.test');
    const cookies = { ...management, '__Host-commerce_session': account.session };
    const url = `/api/v1/booking/management/${reservationId}`;
    const patchKey = randomUUID();
    const missingPatch = await app.inject({ method: 'PATCH', url, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': patchKey }, payload: { primaryGuestName: 'After CSRF' } });
    expect(missingPatch.statusCode).toBe(403);
    const patch = await app.inject({ method: 'PATCH', url, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': patchKey, 'x-csrf-token': account.csrf }, payload: { primaryGuestName: 'After CSRF' } });
    expect(patch.statusCode, patch.body).toBe(200);
    const claimKey = randomUUID();
    const missingClaim = await app.inject({ method: 'POST', url: `${url}/claim`, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': claimKey } });
    expect(missingClaim.statusCode).toBe(403);
    const claim = await app.inject({ method: 'POST', url: `${url}/claim`, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': claimKey, 'x-csrf-token': account.csrf } });
    expect(claim.statusCode, claim.body).toBe(200);
    const resendKey = randomUUID();
    const missingResend = await app.inject({ method: 'POST', url: `${url}/resend-access-grant`, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': resendKey } });
    expect(missingResend.statusCode).toBe(403);
    const resend = await app.inject({ method: 'POST', url: `${url}/resend-access-grant`, cookies, remoteAddress: '198.51.100.18', headers: { 'idempotency-key': resendKey, 'x-csrf-token': account.csrf } });
    expect(resend.statusCode, resend.body).toBe(200);

    for (const [method, path, payload] of [
      ['PATCH', url, { primaryGuestName: 'Cross Origin' }],
      ['POST', `${url}/resend-access-grant`, undefined],
    ] as const) {
      const crossed = await app.inject({ method, url: path, cookies: management, remoteAddress: '198.51.100.19', headers: { origin: 'https://attacker.example.test', 'idempotency-key': randomUUID() }, payload });
      expect(crossed.statusCode).toBe(403);
      expect(crossed.body).not.toContain(management['__Host-booking_reservation_management']);
    }
  });

  it('returns a safe claim conflict to another authenticated Account without changing the owner', async () => {
    const reservationId = (await quoteThenCreate(randomUUID(), 27)).create.json().data.reservation.id as string;
    const grant = await issueGrant(reservationId);
    const management = managementCookies(await redeem(reservationId, grant, '198.51.100.20'));
    const first = await registerAccount('claim-first@example.test');
    const second = await registerAccount('claim-second@example.test');
    const url = `/api/v1/booking/management/${reservationId}`;
    const claim = (session: string, csrf: string) => app.inject({ method: 'POST', url: `${url}/claim`, cookies: { ...management, '__Host-commerce_session': session }, remoteAddress: '198.51.100.20', headers: { 'x-csrf-token': csrf, 'idempotency-key': randomUUID() } });
    expect((await claim(first.session, first.csrf)).statusCode).toBe(200);
    const conflict = await claim(second.session, second.csrf);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain(management['__Host-booking_reservation_management']);
    expect(conflict.body).not.toContain('private.booker@example.test');
    const owned = await app.inject({ method: 'GET', url, cookies: { '__Host-commerce_session': first.session }, remoteAddress: '198.51.100.20' });
    expect(owned.statusCode).toBe(200);
    const notOwned = await app.inject({ method: 'GET', url, cookies: { '__Host-commerce_session': second.session }, remoteAddress: '198.51.100.20' });
    expect(notOwned.statusCode).toBe(404);
    const operatorPath = `/api/v1/booking/management/${reservationId}/operator`;
    expect((await app.inject({ method: 'GET', url: operatorPath, remoteAddress: '198.51.100.20' })).statusCode).toBe(404);
  });

  it('redacts credentials and unrelated PII from every management response and captured diagnostic', async () => {
    const reservationId = (await quoteThenCreate(randomUUID(), 28)).create.json().data.reservation.id as string;
    const grant = await issueGrant(reservationId);
    const account = await registerAccount('redaction-owner@example.test');
    const url = `/api/v1/booking/management/${reservationId}`;
    diagnosticLines.length = 0;
    const redeemed = await redeem(reservationId, grant, '198.51.100.21');
    expect(redeemed.statusCode).toBe(303);
    const management = managementCookies(redeemed);
    const credential = management['__Host-booking_reservation_management'];
    const read = await app.inject({ method: 'GET', url, cookies: management, remoteAddress: '198.51.100.21' });
    const updated = await app.inject({ method: 'PATCH', url, cookies: management, remoteAddress: '198.51.100.21', headers: { 'idempotency-key': randomUUID() }, payload: { primaryGuestName: 'Redacted Guest' } });
    const claimed = await app.inject({ method: 'POST', url: `${url}/claim`, cookies: { ...management, '__Host-commerce_session': account.session }, remoteAddress: '198.51.100.21', headers: { 'idempotency-key': randomUUID(), 'x-csrf-token': account.csrf } });
    const cancelled = await app.inject({ method: 'POST', url: `${url}/cancel`, cookies: { '__Host-commerce_session': account.session }, remoteAddress: '198.51.100.21', headers: { 'idempotency-key': randomUUID(), 'x-csrf-token': account.csrf } });
    const resent = await app.inject({ method: 'POST', url: `${url}/resend-access-grant`, cookies: { '__Host-commerce_session': account.session }, remoteAddress: '198.51.100.21', headers: { 'idempotency-key': randomUUID(), 'x-csrf-token': account.csrf } });
    expect([read, updated, claimed, cancelled, resent].map(response => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(read.json().data.reservation.booker.email).toBe('private.booker@example.test');
    for (const response of [redeemed, read, updated, claimed, cancelled, resent]) {
      const text = response.body;
      for (const secret of [grant, credential, account.session, account.csrf]) expect(text).not.toContain(secret);
    }
    for (const response of [updated, claimed, cancelled, resent]) {
      expect(response.body).not.toContain('private.booker@example.test');
      expect(response.body).not.toContain('Private note');
      expect(response.body).not.toContain('Redacted Guest');
    }
    expect(diagnosticLines.length).toBeGreaterThan(0);
    const diagnostics = JSON.stringify(diagnosticLines);
    for (const secret of [grant, credential, account.session, account.csrf]) expect(diagnostics).not.toContain(secret);
    expect(diagnostics).not.toContain('private.booker@example.test');
    expect(diagnostics).not.toContain('Private note');
    expect(diagnostics).not.toContain('Redacted Guest');
  });
});
