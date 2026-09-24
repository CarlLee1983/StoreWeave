import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, type Actor } from '@storeweave/contracts';
import { createKeyring } from '@storeweave/crypto';
import { bindModuleCapability, createRuntime, resolveKeyring, type Runtime } from '@storeweave/kernel';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindBookingAvailabilityQuoteReservation, createBookingAvailabilityModule,
  BOOKING_PROPERTY_READ_CAPABILITY,
} from '../../packages/booking/availability/src/module';
import { createBookingAvailabilityQuoteReservation } from '../../packages/booking/availability/src/quote-reservation';
import { createBookingAvailabilityQuote } from '../../packages/booking/availability/src/quote';
import type { BookingPropertyLockedQuoteFactsLookup } from '../../packages/booking/availability/src/types';
import type { BookingQuote, BookingQuoteResult } from '../../packages/booking/availability/src/quote';
import { bookingPropertyRead } from '../../packages/booking/property/src/service';
import { createBookingPropertyModule } from '../../packages/booking/property/src/module';

const actorWith = (permissions: string[]): Actor => ({
  id: 'test:booking-quote-reservation', type: 'user', displayName: 'Booking Quote Reservation Test', permissions,
});
const PROPERTY_MANAGER = actorWith(['booking-property:manage', 'booking-availability:manage']);
const AVAILABILITY_MANAGER = actorWith(['booking-availability:manage']);
const QUOTE_ACTOR = actorWith(['booking-availability:quote']);
const BOOKING_TEST_ROLES = {
  ...BASE_ROLES,
  visitor: { ...BASE_ROLES.visitor, permissions: [...BASE_ROLES.visitor.permissions, 'booking-availability:quote'] },
};
const PROPERTY_TIME_ZONE = 'America/Los_Angeles';
const QUOTE_LIMITS = { maxRoomsPerRequest: 4 };
const TEST_SECRET = Buffer.alloc(32, 6).toString('base64url');
const runtimes: Runtime[] = [];
const containers: StartedPostgreSqlContainer[] = [];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlocker(runtime: Runtime, blockedPid: number, blockingPid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runtime.database.pool.query<{ blockers: number[] }>(
      'SELECT pg_catalog.pg_blocking_pids($1::integer) AS blockers', [blockedPid],
    );
    if (result.rows[0]?.blockers.includes(blockingPid)) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

afterEach(async () => {
  await Promise.allSettled([
    ...runtimes.splice(0).map(runtime => runtime.close()),
    ...containers.splice(0).map(container => container.stop()),
  ]);
});

function localDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: PROPERTY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + days);
  date.setUTCHours(0, 0, 0, 0);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function start() {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_quote_reservation')
    .withUsername('booking')
    .withPassword('booking')
    .start();
  containers.push(container);
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-quote-reservation-test', name: 'Booking Quote Reservation Test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = {
    get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? TEST_SECRET : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
    listNames: () => ['SW_SIGNING_KEY_TEST'],
  };
  const keyring = resolveKeyring(config, secrets)!;
  const quoteReservation = bindBookingAvailabilityQuoteReservation(propertyBinding, QUOTE_LIMITS, keyring).value;
  const runtime = await createRuntime({
    release: { id: 'booking-quote-reservation-test', version: '1.0.0', buildManifestChecksum: `sha256:${'7'.repeat(64)}` },
    roles: BOOKING_TEST_ROLES, config, secrets,
    logger: noopLogger, availableExtensions: {},
    modules: [createBookingAvailabilityModule(propertyBinding, QUOTE_LIMITS, keyring), createBookingPropertyModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return { runtime, quoteReservation };
}

const propertyInput = (freeCancellationHoursBeforeCheckIn = 48) => ({
  name: '海角旅店', address: {
    countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles',
    addressLine1: 'Ocean Avenue 1', addressLine2: null,
  }, timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn },
});

async function createFixture(runtime: Runtime, sellableUnits = 3) {
  const property = await runtime.commands.execute<{ id: string }>('booking.property.create', propertyInput(), {
    actor: PROPERTY_MANAGER, idempotencyKey: randomUUID(),
  });
  const roomType = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
    code: 'coast-double', name: '海景雙人房', description: null, maxOccupancyPerUnit: 2,
    beds: [{ type: 'queen' as const, count: 1 }], amenities: [], minimumStayNights: 1,
    maximumStayNights: null, mediaAssetId: null,
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
    roomTypeId: roomType.id, baseNightlyPriceMinor: 12_345,
  }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
  const checkInLocalDate = addDays(localDate(new Date()), 7);
  const checkOutLocalDate = addDays(checkInLocalDate, 2);
  const request = { roomTypeId: roomType.id, checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 };
  await runtime.commands.execute('booking.availability.updateRoomNightRange', {
    roomTypeId: roomType.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate,
    sellableUnits,
  }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
  return { property, roomType, request };
}

async function getQuote(runtime: Runtime, request: { roomTypeId: string; checkInLocalDate: string; checkOutLocalDate: string; adults: number; children: number; roomCount: number }): Promise<BookingQuote> {
  const result = await runtime.queries.execute<BookingQuoteResult>('booking.availability.getQuote', request, { actor: QUOTE_ACTOR });
  if (result.kind !== 'available') throw new Error('Test fixture did not produce an available Quote');
  return result.quote;
}

async function reservedCounts(runtime: Runtime, roomTypeId: string): Promise<number[]> {
  const result = await runtime.database.pool.query<{ reserved_units: number }>(
    'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date', [roomTypeId],
  );
  return result.rows.map(row => row.reserved_units);
}

describe('Booking Availability atomic Quote reservation PostgreSQL integration', () => {
  it('reserves exact current terms and caller rollback restores every night', async () => {
    const { runtime, quoteReservation } = await start();
    const { roomType, request } = await createFixture(runtime);
    const quote = await getQuote(runtime, request);

    await expect(runtime.database.transaction(async tx => {
      await expect(quoteReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date()))
        .resolves.toEqual({ kind: 'reserved', quote });
      throw new Error('rollback caller transaction');
    })).rejects.toThrow('rollback caller transaction');
    expect(await reservedCounts(runtime, roomType.id)).toEqual([0, 0]);

    await expect(runtime.database.transaction(tx => quoteReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date())))
      .resolves.toEqual({ kind: 'reserved', quote });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([1, 1]);
  }, 120_000);

  it('returns refreshed terms for changed price or policy and rejects tampered or unknown-key fingerprints', async () => {
    const { runtime, quoteReservation } = await start();
    const { roomType, request } = await createFixture(runtime);
    const original = await getQuote(runtime, request);

    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
      roomTypeId: roomType.id, baseNightlyPriceMinor: 13_000,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    const changedPrice = await runtime.database.transaction(tx => quoteReservation.revalidateAndReserve(tx, request, original.fingerprint, new Date()));
    expect(changedPrice).toMatchObject({ kind: 'stale', replacementQuote: { totalMinor: 26_000 } });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([0, 0]);

    await runtime.commands.execute('booking.property.update', propertyInput(24), {
      actor: PROPERTY_MANAGER, idempotencyKey: randomUUID(),
    });
    const changedPolicy = await runtime.database.transaction(tx => quoteReservation.revalidateAndReserve(tx, request, original.fingerprint, new Date()));
    expect(changedPolicy).toMatchObject({
      kind: 'stale', replacementQuote: { cancellationPolicy: { freeCancellationHoursBeforeCheckIn: 24 } },
    });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([0, 0]);

    const [, , mac] = original.fingerprint.split(':');
    const tampered = `booking-quote-v1:test:${mac![0] === '0' ? '1' : '0'}${mac!.slice(1)}`;
    const unknownKey = `booking-quote-v1:removed:${mac}`;
    for (const fingerprint of [tampered, unknownKey]) {
      await expect(runtime.database.transaction(tx => quoteReservation.revalidateAndReserve(tx, request, fingerprint, new Date())))
        .resolves.toMatchObject({ kind: 'stale', replacementQuote: { fingerprint: expect.stringMatching(/^booking-quote-v1:test:/) } });
    }

    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId: roomType.id,
      startLocalDate: addDays(request.checkInLocalDate, 1),
      endLocalDateExclusive: request.checkOutLocalDate,
      sellableUnits: 0,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    await expect(runtime.database.transaction(tx => quoteReservation.revalidateAndReserve(tx, request, original.fingerprint, new Date())))
      .resolves.toEqual({ kind: 'unavailable' });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([0, 0]);
  }, 120_000);

  it('accepts a configured retired Quote key and returns the active signing key', async () => {
    const { runtime } = await start();
    const { roomType, request } = await createFixture(runtime);
    const retiredKeyring = createKeyring({
      activeKeyId: 'retired', keys: [{ id: 'retired', secret: TEST_SECRET }],
    });
    const retiredQuoteResult = await createBookingAvailabilityQuote(bookingPropertyRead, QUOTE_LIMITS, retiredKeyring)
      .quote(runtime.database.db, request, new Date());
    if (retiredQuoteResult.kind !== 'available') throw new Error('Test fixture did not produce a retired-key Quote');
    const retiredQuote = retiredQuoteResult.quote;
    expect(retiredQuote.fingerprint).toMatch(/^booking-quote-v1:retired:/);

    const rotatedKeyring = createKeyring({
      activeKeyId: 'active',
      keys: [
        { id: 'retired', secret: TEST_SECRET },
        { id: 'active', secret: Buffer.alloc(32, 8).toString('base64url') },
      ],
    });
    const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
    const rotatedReservation = bindBookingAvailabilityQuoteReservation(propertyBinding, QUOTE_LIMITS, rotatedKeyring).value;
    const result = await runtime.database.transaction(tx => rotatedReservation.revalidateAndReserve(tx, request, retiredQuote.fingerprint, new Date()));
    expect(result).toMatchObject({ kind: 'reserved', quote: { fingerprint: expect.stringMatching(/^booking-quote-v1:active:/) } });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([1, 1]);
  }, 120_000);

  it('rejects malformed fingerprint syntax before the Property provider is called', async () => {
    const { runtime } = await start();
    const { request } = await createFixture(runtime);
    const quote = await getQuote(runtime, request);
    let propertyRead = false;
    const propertyProvider = {
      ...bookingPropertyRead,
      async requireLockedQuoteFacts() {
        propertyRead = true;
        throw new Error('Property provider must not be called for malformed fingerprint syntax');
      },
    };
    const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, propertyProvider);
    const noReadReservation = bindBookingAvailabilityQuoteReservation(
      propertyBinding,
      QUOTE_LIMITS,
      createKeyring({ activeKeyId: 'test', keys: [{ id: 'test', secret: TEST_SECRET }] }),
    ).value;
    await expect(runtime.database.transaction(tx => noReadReservation.revalidateAndReserve(tx, request, 'malformed', new Date())))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.database.transaction(tx => noReadReservation.revalidateAndReserve(
      tx, { ...request, roomCount: QUOTE_LIMITS.maxRoomsPerRequest + 1 }, quote.fingerprint, new Date(),
    ))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(propertyRead).toBe(false);

    let availabilityRead = false;
    const invalidOwnerFacts: BookingPropertyLockedQuoteFactsLookup = {
      async requireLockedQuoteFacts() {
        return {
          property: {
            id: randomUUID(), timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00',
            defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
          },
          roomType: { id: request.roomTypeId, maxOccupancyPerUnit: 1, minimumStayNights: 1, maximumStayNights: null },
        };
      },
    };
    const invalidOwnerReservation = createBookingAvailabilityQuoteReservation(
      invalidOwnerFacts,
      QUOTE_LIMITS,
      createKeyring({ activeKeyId: 'test', keys: [{ id: 'test', secret: TEST_SECRET }] }),
      {
        async lockBasePrice() { availabilityRead = true; return null; },
        async materializeRoomNightsInDateOrder() {},
        async lockRoomNights() { return []; },
        async adjustReservedUnits() { return 0; },
      },
    );
    await expect(runtime.database.transaction(tx => invalidOwnerReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date())))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(availabilityRead).toBe(false);
  }, 120_000);

  it('serializes two attempts for the final unit and lets the first caller retain locks through commit', async () => {
    const { runtime, quoteReservation } = await start();
    const { roomType, request } = await createFixture(runtime, 1);
    const quote = await getQuote(runtime, request);
    const releaseFirst = deferred();
    const firstHasReserved = deferred<number>();
    const secondStarted = deferred<number>();

    const first = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      const result = await quoteReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date());
      firstHasReserved.resolve(pid);
      await releaseFirst.promise;
      return result;
    });
    const firstPid = await firstHasReserved.promise;
    const second = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      secondStarted.resolve(pid);
      return quoteReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date());
    });
    const secondPid = await secondStarted.promise;
    let blocked = false;
    try {
      blocked = await waitForBlocker(runtime, secondPid, firstPid);
    } finally {
      releaseFirst.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(blocked).toBe(true);
    expect(firstResult).toMatchObject({ kind: 'reserved' });
    expect(secondResult).toEqual({ kind: 'unavailable' });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([1, 1]);
  }, 120_000);

  it('holds Property and base-price locks through reserve so concurrent term updates cannot slip into the Quote', async () => {
    const { runtime, quoteReservation } = await start();
    const { property, roomType, request } = await createFixture(runtime);
    const quote = await getQuote(runtime, request);
    const releaseReservation = deferred();
    const reservationReady = deferred<number>();
    const policyUpdateStarting = deferred<number>();
    const priceUpdateStarting = deferred<number>();

    const reservation = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      const result = await quoteReservation.revalidateAndReserve(tx, request, quote.fingerprint, new Date());
      reservationReady.resolve(pid);
      await releaseReservation.promise;
      return result;
    });
    const reservationPid = await reservationReady.promise;
    const policyUpdate = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      policyUpdateStarting.resolve(pid);
      await tx.execute(sql`UPDATE booking_property_properties SET default_policy = ${JSON.stringify({ freeCancellationHoursBeforeCheckIn: 24 })}::jsonb WHERE id = ${property.id}`);
    });
    const priceUpdate = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      priceUpdateStarting.resolve(pid);
      await tx.execute(sql`UPDATE booking_availability_room_type_prices SET base_nightly_price_minor = 13_000 WHERE room_type_id = ${roomType.id}`);
    });
    const policyUpdatePid = await policyUpdateStarting.promise;
    const priceUpdatePid = await priceUpdateStarting.promise;

    try {
      expect(await waitForBlocker(runtime, policyUpdatePid, reservationPid)).toBe(true);
      expect(await waitForBlocker(runtime, priceUpdatePid, reservationPid)).toBe(true);
    } finally {
      releaseReservation.resolve();
    }
    const [result] = await Promise.all([reservation, policyUpdate, priceUpdate]);
    expect(result).toMatchObject({ kind: 'reserved', quote });
    expect(await reservedCounts(runtime, roomType.id)).toEqual([1, 1]);
  }, 120_000);
});
