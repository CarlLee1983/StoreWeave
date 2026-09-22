import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { resolveKeyring, bindModuleCapability, createRuntime, type Runtime } from '@storeweave/kernel';
import type { PaymentProviderV2 } from '@storeweave/extension-sdk';
import {
  bindBookingAvailabilityQuoteReservation, BOOKING_PROPERTY_READ_CAPABILITY,
  createBookingAvailabilityModule, BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  bookingAvailabilityRoomNightOperations,
} from '../../packages/booking/availability/src';
import { bookingPropertyRead, createBookingPropertyModule } from '../../packages/booking/property/src';
import { createBookingReservationAccess, createBookingReservationModule } from '../../packages/booking/reservation/src';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { bookingHttpAdapter } from '../../apps/api/src/releases/booking';

const signingSecret = Buffer.alloc(32, 4).toString('base64url');
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
  parseCallback: async () => { throw new Error('Not used by booking public HTTP'); },
  acknowledgeCallback: () => ({ body: 'ok' }),
};

let container: StartedPostgreSqlContainer;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof createReleaseServer>>;
let roomTypeId: string;
let quoteInput: Record<string, unknown>;

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

async function quoteThenCreate(key: string) {
  const quote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: quoteInput });
  expect(quote.statusCode, quote.body).toBe(201);
  const fingerprint = quote.json().data.quote.fingerprint as string;
  const create = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations', headers: { 'idempotency-key': key }, payload: {
    quote: { ...quoteInput, fingerprint },
    booker: { name: 'Private Booker', email: 'private.booker@example.test', phone: '+1 555 0100' },
    primaryGuestName: 'Private Guest', accommodationNotes: 'Private note',
  } });
  expect(create.statusCode, create.body).toBe(201);
  return { create, payload: {
    quote: { ...quoteInput, fingerprint },
    booker: { name: 'Private Booker', email: 'private.booker@example.test', phone: '+1 555 0100' },
    primaryGuestName: 'Private Guest', accommodationNotes: 'Private note',
  } };
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
  const keyring = resolveKeyring(config, secrets)!;
  const property = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const quoteReservation = bindBookingAvailabilityQuoteReservation(property, { maxRoomsPerRequest: 4 }, keyring);
  const roomNights = bindModuleCapability('booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, bookingAvailabilityRoomNightOperations);
  runtime = await createRuntime({ release: { id: 'booking-public-http', version: '1.0.0', buildManifestChecksum: `sha256:${'4'.repeat(64)}` },
    roles: BASE_ROLES, config, secrets, logger: noopLogger, availableExtensions: {}, modules: [
      createBookingAvailabilityModule(property, { maxRoomsPerRequest: 4 }, keyring), createBookingPropertyModule(),
      createBookingReservationModule(quoteReservation, roomNights, createBookingReservationAccess(keyring), { reservationPiiRetentionDays: 1 }, testProvider),
    ] });
  await runtime.migrate();
  await runtime.commands.execute('booking.property.create', { name: 'HTTP Test Hotel', address: { countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles', addressLine1: 'Ocean 1', addressLine2: null }, timezone: 'America/Los_Angeles', currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00', defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 } }, { actor: manager, idempotencyKey: randomUUID() });
  const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', { code: 'http', name: 'HTTP room', description: null, maxOccupancyPerUnit: 4, beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null }, { actor: manager, idempotencyKey: randomUUID() });
  roomTypeId = room.id;
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', { roomTypeId, baseNightlyPriceMinor: 12_345 }, { actor: manager, idempotencyKey: randomUUID() });
  const checkInLocalDate = addDays(localDate(new Date()), 7);
  const checkOutLocalDate = addDays(checkInLocalDate, 2);
  await runtime.commands.execute('booking.availability.updateRoomNightRange', { roomTypeId, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate, sellableUnits: 4 }, { actor: manager, idempotencyKey: randomUUID() });
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
    expect(bookingRoutes).toHaveLength(7);
    expect(bookingRoutes.map(route => route.path).sort()).toEqual([
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
