import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { createBookingPropertyModule } from '../../packages/booking/property/src/module';
import { bookingPropertyRead } from '../../packages/booking/property/src/service';
import type { PropertyDto } from '../../packages/booking/property/src/types';
import { actorWith, createTestDatabase, testSecretProvider } from './helpers';

const MANAGER = actorWith(['booking-property:manage']);
const PROPERTY_READER = actorWith(['booking-property:read']);
const PUBLIC_READER = actorWith(['booking-property:public-read']);
const runtimes: Runtime[] = [];

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

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start() {
  const databaseUrl = await createTestDatabase();
  const runtime = await createRuntime({
    release: { id: 'booking-property-test', version: '1.0.0', buildManifestChecksum: `sha256:${'4'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1, store: { id: 'booking-property-test', name: 'Booking Property Test' },
      database: { url: databaseUrl }, logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 4).toString('base64url') }),
    logger: noopLogger, availableExtensions: {}, modules: [createBookingPropertyModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

const propertyInput = () => ({
  name: '山城旅店', address: {
    countryCode: 'TW', postalCode: '400', administrativeArea: '臺中市', locality: '中區',
    addressLine1: '自由路 1 號', addressLine2: null,
  }, timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
});

const roomTypeInput = (overrides: Record<string, unknown> = {}) => ({
  code: 'mountain-double', name: '山景雙人房', description: '面山雙人客房', maxOccupancyPerUnit: 2,
  beds: [{ type: 'queen', count: 1 }], amenities: [{ code: 'wifi', label: '無線網路' }],
  minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null, ...overrides,
});

const roomTypeUpdateInput = (overrides: Record<string, unknown> = {}) => {
  const { code: _immutableCode, ...facts } = roomTypeInput(overrides);
  return facts;
};

async function createProperty(runtime: Runtime) {
  return runtime.commands.execute<PropertyDto>('booking.property.create', propertyInput(), { actor: MANAGER, idempotencyKey: randomUUID() });
}

describe('Booking Property and Room Type', () => {
  it('persists one Property and Room Type facts and serves the read-only capability', async () => {
    const runtime = await start();
    const property = await createProperty(runtime);
    const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', roomTypeInput(), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    });
    await expect(runtime.commands.execute('booking.property.createRoomType', roomTypeInput(), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await runtime.queries.execute('booking.property.getProperty', {}, { actor: PROPERTY_READER })).toMatchObject({
      id: property.id, timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00', checkOutTime: '11:00',
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
    });
    expect(await runtime.queries.execute('booking.property.getPublicProperty', {}, { actor: PUBLIC_READER }))
      .toMatchObject({ id: property.id, name: propertyInput().name });
    expect(await runtime.queries.execute('booking.property.getActiveRoomType', { roomTypeId: room.id }, { actor: PUBLIC_READER }))
      .toMatchObject({ id: room.id, status: 'active' });
    await expect(runtime.queries.execute('booking.property.getPublicProperty', {}, { actor: PROPERTY_READER }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.queries.execute('booking.property.getActiveRoomType', { roomTypeId: room.id }, { actor: PROPERTY_READER }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await bookingPropertyRead.getProperty(runtime.database.db)).toMatchObject({ id: property.id, address: propertyInput().address });
    expect(await bookingPropertyRead.getActiveRoomType(runtime.database.db, room.id)).toMatchObject({
      id: room.id, maxOccupancyPerUnit: 2, beds: [{ type: 'queen', count: 1 }], minimumStayNights: 1,
      maximumStayNights: null, mediaAssetId: null,
    });
    expect(await runtime.queries.execute('booking.property.listActiveRoomTypes', {}, { actor: PUBLIC_READER })).toMatchObject([{ id: room.id, status: 'active' }]);

    await runtime.commands.execute('booking.property.update', {
      ...propertyInput(), name: '山城旅店本館', checkInTime: '16:00',
    }, { actor: MANAGER, idempotencyKey: randomUUID() });
    expect(await runtime.queries.execute('booking.property.getProperty', {}, { actor: PROPERTY_READER })).toMatchObject({
      id: property.id, name: '山城旅店本館', checkInTime: '16:00',
    });

    await runtime.commands.execute('booking.property.updateRoomType', {
      ...roomTypeUpdateInput(), roomTypeId: room.id, status: 'disabled',
    }, { actor: MANAGER, idempotencyKey: randomUUID() });
    expect(await bookingPropertyRead.getActiveRoomType(runtime.database.db, room.id)).toBeNull();
    expect(await runtime.queries.execute('booking.property.getActiveRoomType', { roomTypeId: room.id }, { actor: PUBLIC_READER })).toBeNull();
    expect(await runtime.queries.execute('booking.property.getActiveRoomType', { roomTypeId: randomUUID() }, { actor: PUBLIC_READER })).toBeNull();
    expect(await runtime.queries.execute('booking.property.listRoomTypes', {}, { actor: MANAGER })).toMatchObject([{ id: room.id, status: 'disabled' }]);
    expect((await runtime.database.pool.query('SELECT code FROM booking_property_room_types WHERE id = $1', [room.id])).rows)
      .toEqual([{ code: 'mountain-double' }]);

    await expect(runtime.queries.execute('booking.property.getProperty', {}, { actor: MANAGER }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.queries.execute('booking.property.listActiveRoomTypes', {}, { actor: PROPERTY_READER }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.commands.execute('booking.property.update', propertyInput(), {
      actor: PROPERTY_READER, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns narrow Quote facts and locks Property before Room Type until caller commit', async () => {
    const runtime = await start();
    const property = await createProperty(runtime);
    const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', roomTypeInput({
      minimumStayNights: 2, maximumStayNights: 7, maxOccupancyPerUnit: 3,
    }), { actor: MANAGER, idempotencyKey: randomUUID() });
    const propertyBefore = await runtime.database.pool.query(
      'SELECT name, timezone, currency, check_in_time, default_policy, updated_at FROM booking_property_properties WHERE id = $1', [property.id],
    );
    const roomTypeBefore = await runtime.database.pool.query(
      'SELECT status, max_occupancy_per_unit, minimum_stay_nights, maximum_stay_nights, updated_at FROM booking_property_room_types WHERE id = $1', [room.id],
    );
    const releaseRoomTypeLock = deferred();
    const releaseQuoteFactsTransaction = deferred();
    const roomTypeLocked = deferred<number>();
    const quoteFactsWaiting = deferred<number>();
    const quoteFactsReady = deferred<Awaited<ReturnType<typeof bookingPropertyRead.requireLockedQuoteFacts>>>();
    const propertyUpdateWaiting = deferred<number>();
    const roomTypeUpdateWaiting = deferred<number>();

    const roomTypeLock = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      await tx.execute(sql`SELECT id FROM booking_property_room_types WHERE id = ${room.id} FOR UPDATE`);
      roomTypeLocked.resolve(pid);
      await releaseRoomTypeLock.promise;
    });
    const roomTypeLockPid = await roomTypeLocked.promise;
    const facts = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      quoteFactsWaiting.resolve(pid);
      const result = await bookingPropertyRead.requireLockedQuoteFacts(tx, room.id);
      quoteFactsReady.resolve(result);
      await releaseQuoteFactsTransaction.promise;
      return result;
    });
    const factsPid = await quoteFactsWaiting.promise;
    const factsBlockedOnRoomType = await waitForBlocker(runtime, factsPid, roomTypeLockPid);
    const updateProperty = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      propertyUpdateWaiting.resolve(pid);
      await tx.execute(sql`UPDATE booking_property_properties SET name = name WHERE id = ${property.id}`);
    });
    const propertyUpdatePid = await propertyUpdateWaiting.promise;
    const updateBlockedOnQuoteFacts = await waitForBlocker(runtime, propertyUpdatePid, factsPid);

    try {
      expect(factsBlockedOnRoomType).toBe(true);
      expect(updateBlockedOnQuoteFacts).toBe(true);
      releaseRoomTypeLock.resolve();
      const returnedFacts = await quoteFactsReady.promise;
      expect(Object.isFrozen(returnedFacts)).toBe(true);
      expect(Object.isFrozen(returnedFacts.property)).toBe(true);
      expect(Object.isFrozen(returnedFacts.property.defaultPolicy)).toBe(true);
      expect(Object.isFrozen(returnedFacts.roomType)).toBe(true);

      const updateRoomType = runtime.database.transaction(async tx => {
        const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        roomTypeUpdateWaiting.resolve(pid);
        await tx.execute(sql`UPDATE booking_property_room_types SET name = name WHERE id = ${room.id}`);
      });
      const roomTypeUpdatePid = await roomTypeUpdateWaiting.promise;
      expect(await waitForBlocker(runtime, roomTypeUpdatePid, factsPid)).toBe(true);
      releaseQuoteFactsTransaction.resolve();
      await Promise.all([updateRoomType, facts]);
    } finally {
      releaseRoomTypeLock.resolve();
      releaseQuoteFactsTransaction.resolve();
    }

    await expect(facts).resolves.toEqual({
      property: {
        id: property.id, timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00',
        defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
      },
      roomType: { id: room.id, maxOccupancyPerUnit: 3, minimumStayNights: 2, maximumStayNights: 7 },
    });
    await Promise.all([roomTypeLock, updateProperty]);
    expect((await runtime.database.pool.query(
      'SELECT name, timezone, currency, check_in_time, default_policy, updated_at FROM booking_property_properties WHERE id = $1', [property.id],
    )).rows).toEqual(propertyBefore.rows);
    expect((await runtime.database.pool.query(
      'SELECT status, max_occupancy_per_unit, minimum_stay_nights, maximum_stay_nights, updated_at FROM booking_property_room_types WHERE id = $1', [room.id],
    )).rows).toEqual(roomTypeBefore.rows);
  }, 120_000);

  it('validates the id before lookup and reports missing Property or inactive Room Type', async () => {
    const runtime = await start();
    await expect(runtime.database.transaction(tx => bookingPropertyRead.requireLockedQuoteFacts(tx, randomUUID())))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    const property = await createProperty(runtime);
    const releasePropertyLock = deferred();
    const propertyLocked = deferred();
    const propertyLock = runtime.database.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM booking_property_properties WHERE id = ${property.id} FOR UPDATE`);
      propertyLocked.resolve();
      await releasePropertyLock.promise;
    });
    await propertyLocked.promise;
    const invalidAttempt = runtime.database.transaction(tx => bookingPropertyRead.requireLockedQuoteFacts(tx, 'not-a-uuid'));
    const invalidResult = invalidAttempt.then(
      () => 'resolved',
      error => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unexpected-error',
    );
    let invalidLookupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        invalidResult,
        new Promise<'timeout'>(resolve => { invalidLookupTimeout = setTimeout(() => resolve('timeout'), 1_000); }),
      ])).toBe('VALIDATION_ERROR');
    } finally {
      if (invalidLookupTimeout) clearTimeout(invalidLookupTimeout);
      releasePropertyLock.resolve();
      await Promise.allSettled([propertyLock, invalidAttempt]);
    }
    await expect(runtime.database.transaction(tx => bookingPropertyRead.requireLockedQuoteFacts(tx, randomUUID())))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', roomTypeInput(), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    });
    await runtime.commands.execute('booking.property.updateRoomType', {
      ...roomTypeUpdateInput(), roomTypeId: room.id, status: 'disabled',
    }, { actor: MANAGER, idempotencyKey: randomUUID() });
    await expect(runtime.database.transaction(tx => bookingPropertyRead.requireLockedQuoteFacts(tx, room.id)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);

  it('rejects a second Property and invalid facts without persisting rows', async () => {
    const runtime = await start();
    await createProperty(runtime);
    await expect(createProperty(runtime)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runtime.commands.execute('booking.property.update', {
      ...propertyInput(), timezone: 'Mars/Olympus_Mons',
    }, { actor: MANAGER, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.property.createRoomType', roomTypeInput({ maximumStayNights: 0 }), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(runtime.commands.execute('booking.property.createRoomType', roomTypeInput({ mediaAssetId: randomUUID() }), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const properties = await runtime.database.pool.query('SELECT id FROM booking_property_properties');
    const unchangedProperty = await runtime.database.pool.query(
      'SELECT name, timezone, currency FROM booking_property_properties',
    );
    const roomTypes = await runtime.database.pool.query('SELECT id FROM booking_property_room_types');
    expect(properties.rows).toHaveLength(1);
    expect(unchangedProperty.rows).toEqual([{ name: '山城旅店', timezone: 'Asia/Taipei', currency: 'TWD' }]);
    expect(roomTypes.rows).toEqual([]);
  });

  it('replaces a Media reference transactionally and rolls back an invalid replacement', async () => {
    const runtime = await start();
    await createProperty(runtime);
    const mediaAssetId = randomUUID();
    await runtime.database.pool.query(`INSERT INTO platform_media_assets
      (id, original_object_id, preview_object_id, status, width, height) VALUES ($1, $2, $3, 'ready', 32, 32)`,
    [mediaAssetId, randomUUID(), randomUUID()]);
    const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', roomTypeInput({ mediaAssetId }), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    });
    const originalReference = await runtime.database.pool.query(
      'SELECT media_asset_id FROM platform_media_references WHERE owner_type = $1 AND owner_id = $2',
      ['booking.room-type', room.id],
    );
    expect(originalReference.rows).toEqual([{ media_asset_id: mediaAssetId }]);

    await expect(runtime.commands.execute('booking.property.updateRoomType', {
      ...roomTypeUpdateInput({ mediaAssetId: randomUUID(), name: '不應儲存' }), roomTypeId: room.id, status: 'active',
    }, { actor: MANAGER, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const unchanged = await runtime.database.pool.query(
      'SELECT name, media_asset_id FROM booking_property_room_types WHERE id = $1', [room.id],
    );
    const references = await runtime.database.pool.query(
      'SELECT media_asset_id FROM platform_media_references WHERE owner_type = $1 AND owner_id = $2',
      ['booking.room-type', room.id],
    );
    expect(unchanged.rows).toEqual([{ name: '山景雙人房', media_asset_id: mediaAssetId }]);
    expect(references.rows).toEqual([{ media_asset_id: mediaAssetId }]);

    const replacementMediaId = randomUUID();
    await runtime.database.pool.query(`INSERT INTO platform_media_assets
      (id, original_object_id, preview_object_id, status, width, height) VALUES ($1, $2, $3, 'ready', 48, 48)`,
    [replacementMediaId, randomUUID(), randomUUID()]);
    await runtime.commands.execute('booking.property.updateRoomType', {
      ...roomTypeUpdateInput({ mediaAssetId: replacementMediaId, name: '新媒體雙人房' }), roomTypeId: room.id, status: 'active',
    }, { actor: MANAGER, idempotencyKey: randomUUID() });
    expect((await runtime.database.pool.query(
      'SELECT name, media_asset_id FROM booking_property_room_types WHERE id = $1', [room.id],
    )).rows).toEqual([{ name: '新媒體雙人房', media_asset_id: replacementMediaId }]);
    expect((await runtime.database.pool.query(
      'SELECT media_asset_id FROM platform_media_references WHERE owner_type = $1 AND owner_id = $2',
      ['booking.room-type', room.id],
    )).rows).toEqual([{ media_asset_id: replacementMediaId }]);

    await runtime.commands.execute('booking.property.updateRoomType', {
      ...roomTypeUpdateInput({ mediaAssetId: null }), roomTypeId: room.id, status: 'active',
    }, { actor: MANAGER, idempotencyKey: randomUUID() });
    expect((await runtime.database.pool.query(
      'SELECT media_asset_id FROM booking_property_room_types WHERE id = $1', [room.id],
    )).rows).toEqual([{ media_asset_id: null }]);
    expect((await runtime.database.pool.query(
      'SELECT media_asset_id FROM platform_media_references WHERE owner_type = $1 AND owner_id = $2',
      ['booking.room-type', room.id],
    )).rows).toEqual([]);
  });
});
