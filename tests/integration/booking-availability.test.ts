import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { bindModuleCapability, createRuntime, resolveKeyring, type Runtime } from '@storeweave/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { createBookingAvailabilityModule, BOOKING_PROPERTY_READ_CAPABILITY } from '../../packages/booking/availability/src/module';
import { bookingPropertyRead } from '../../packages/booking/property/src/service';
import { createBookingPropertyModule } from '../../packages/booking/property/src/module';
import type { PropertyDto } from '../../packages/booking/property/src/types';
import { actorWith, createTestDatabase, testSecretProvider } from './helpers';

const MANAGER = actorWith(['booking-property:manage', 'booking-availability:manage']);
const AVAILABILITY_MANAGER = actorWith(['booking-availability:manage']);
const AVAILABILITY_READER = actorWith(['booking-availability:read']);
const runtimes: Runtime[] = [];

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start() {
  const databaseUrl = await createTestDatabase();
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-availability-test', name: 'Booking Availability Test' },
    database: { url: databaseUrl }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 5).toString('base64url') });
  const runtime = await createRuntime({
    release: { id: 'booking-availability-test', version: '1.0.0', buildManifestChecksum: `sha256:${'5'.repeat(64)}` },
    roles: BASE_ROLES,
    config, secrets,
    logger: noopLogger, availableExtensions: {},
    modules: [createBookingAvailabilityModule(
      propertyBinding,
      { maxRoomsPerRequest: 4 },
      resolveKeyring(config, secrets)!,
    ), createBookingPropertyModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

const propertyInput = () => ({
  name: '海角旅店', address: {
    countryCode: 'TW', postalCode: '880', administrativeArea: '澎湖縣', locality: '馬公市',
    addressLine1: '中正路 1 號', addressLine2: null,
  }, timezone: 'America/Los_Angeles', currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
});

const roomTypeInput = () => ({
  code: 'coast-double', name: '海景雙人房', description: null, maxOccupancyPerUnit: 2,
  beds: [{ type: 'queen' as const, count: 1 }], amenities: [], minimumStayNights: 1,
  maximumStayNights: null, mediaAssetId: null,
});

async function createRoomType(runtime: Runtime) {
  await runtime.commands.execute<PropertyDto>('booking.property.create', propertyInput(), {
    actor: MANAGER, idempotencyKey: randomUUID(),
  });
  return runtime.commands.execute<{ id: string }>('booking.property.createRoomType', roomTypeInput(), {
    actor: MANAGER, idempotencyKey: randomUUID(),
  });
}

function roomTypeUpdateInput(roomTypeId: string, status: 'active' | 'disabled') {
  const { code: _immutableCode, ...facts } = roomTypeInput();
  return { ...facts, roomTypeId, status };
}

const setBasePrice = (runtime: Runtime, roomTypeId: string, baseNightlyPriceMinor: number, actor = AVAILABILITY_MANAGER, idempotencyKey = randomUUID()) =>
  runtime.commands.execute('booking.availability.setBaseNightlyPrice', { roomTypeId, baseNightlyPriceMinor }, { actor, idempotencyKey });

const updateRange = (runtime: Runtime, input: Record<string, unknown>, actor = AVAILABILITY_MANAGER, idempotencyKey = randomUUID()) =>
  runtime.commands.execute('booking.availability.updateRoomNightRange', input, { actor, idempotencyKey });

const getRange = (runtime: Runtime, roomTypeId: string, startLocalDate: string, endLocalDateExclusive: string, actor = AVAILABILITY_READER) =>
  runtime.queries.execute<{
    roomTypeId: string;
    propertyTimeZone: string;
    currency: string;
    baseNightlyPriceMinor: number | null;
    nights: Array<{
      localDate: string;
      sellableUnits: number;
      reservedUnits: number;
      nightlyPriceOverrideMinor: number | null;
      effectiveNightlyPriceMinor: number | null;
    }>;
  } | null>('booking.availability.getRoomNightRange', { roomTypeId, startLocalDate, endLocalDateExclusive }, { actor });

describe('Booking Availability administration', () => {
  it('sets base price, materializes a half-open local-date range, preserves or clears overrides, and reads the fallback', async () => {
    const runtime = await start();
    const roomType = await createRoomType(runtime);
    await expect(setBasePrice(runtime, roomType.id, 12_345)).resolves.toMatchObject({
      roomTypeId: roomType.id, baseNightlyPriceMinor: 12_345,
    });
    const range = { roomTypeId: roomType.id, startLocalDate: '2027-03-13', endLocalDateExclusive: '2027-03-15' };
    await updateRange(runtime, { ...range, sellableUnits: 3, nightlyPriceOverrideMinor: 22_200 });
    await updateRange(runtime, { ...range, sellableUnits: 4 });

    let result = await getRange(runtime, roomType.id, '2027-03-13', '2027-03-16');
    expect(result).toMatchObject({
      propertyTimeZone: 'America/Los_Angeles', currency: 'USD', baseNightlyPriceMinor: 12_345,
      nights: [
        { localDate: '2027-03-13', sellableUnits: 4, nightlyPriceOverrideMinor: 22_200, effectiveNightlyPriceMinor: 22_200 },
        { localDate: '2027-03-14', sellableUnits: 4, nightlyPriceOverrideMinor: 22_200, effectiveNightlyPriceMinor: 22_200 },
        { localDate: '2027-03-15', sellableUnits: 0, nightlyPriceOverrideMinor: null, effectiveNightlyPriceMinor: 12_345 },
      ],
    });
    await updateRange(runtime, { roomTypeId: roomType.id, startLocalDate: '2027-03-14', endLocalDateExclusive: '2027-03-15', nightlyPriceOverrideMinor: null });
    await setBasePrice(runtime, roomType.id, 13_500);
    result = await getRange(runtime, roomType.id, '2027-03-13', '2027-03-15');
    expect(result?.nights).toEqual([
      { localDate: '2027-03-13', sellableUnits: 4, reservedUnits: 0, nightlyPriceOverrideMinor: 22_200, effectiveNightlyPriceMinor: 22_200 },
      { localDate: '2027-03-14', sellableUnits: 4, reservedUnits: 0, nightlyPriceOverrideMinor: null, effectiveNightlyPriceMinor: 13_500 },
    ]);
    expect((await runtime.database.pool.query(
      'SELECT room_type_id, local_date::text AS local_date FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date', [roomType.id],
    )).rows).toEqual([
      { room_type_id: roomType.id, local_date: '2027-03-13' },
      { room_type_id: roomType.id, local_date: '2027-03-14' },
    ]);
  });

  it('rejects invalid input and unknown or inactive Room Types before creating daily rows', async () => {
    const runtime = await start();
    const roomType = await createRoomType(runtime);
    const base = { roomTypeId: roomType.id, startLocalDate: '2027-06-01', endLocalDateExclusive: '2027-06-03' };
    await expect(updateRange(runtime, { ...base, sellableUnits: -1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateRange(runtime, { ...base, startLocalDate: '2027-02-29', sellableUnits: 2 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateRange(runtime, { ...base, endLocalDateExclusive: '2027-06-01', sellableUnits: 2 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateRange(runtime, { ...base, endLocalDateExclusive: '2028-06-02', sellableUnits: 2 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateRange(runtime, { ...base, sellableUnits: 2, reservedUnits: 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(setBasePrice(runtime, randomUUID(), 100)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getRange(runtime, randomUUID(), '2027-06-01', '2027-06-03')).resolves.toBeNull();
    expect((await runtime.database.pool.query('SELECT room_type_id FROM booking_availability_room_nights')).rows).toEqual([]);

    await runtime.commands.execute('booking.property.updateRoomType', roomTypeUpdateInput(roomType.id, 'disabled'), {
      actor: MANAGER, idempotencyKey: randomUUID(),
    });
    await expect(setBasePrice(runtime, roomType.id, 100)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateRange(runtime, { ...base, sellableUnits: 2 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await runtime.database.pool.query('SELECT room_type_id FROM booking_availability_room_nights')).rows).toEqual([]);
  });

  it('rejects a batch below any reserved night without changing or materializing any target rows', async () => {
    const runtime = await start();
    const roomType = await createRoomType(runtime);
    await setBasePrice(runtime, roomType.id, 10_000);
    await updateRange(runtime, {
      roomTypeId: roomType.id, startLocalDate: '2027-08-02', endLocalDateExclusive: '2027-08-03', sellableUnits: 5,
    });
    await runtime.database.pool.query(
      'UPDATE booking_availability_room_nights SET reserved_units = 4 WHERE room_type_id = $1 AND local_date = $2',
      [roomType.id, '2027-08-02'],
    );

    await expect(updateRange(runtime, {
      roomTypeId: roomType.id, startLocalDate: '2027-08-01', endLocalDateExclusive: '2027-08-04', sellableUnits: 3,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await runtime.database.pool.query(
      'SELECT local_date::text AS local_date, sellable_units, reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date',
      [roomType.id],
    )).rows).toEqual([{ local_date: '2027-08-02', sellable_units: 5, reserved_units: 4 }]);

    await expect(updateRange(runtime, {
      roomTypeId: roomType.id, startLocalDate: '2027-08-02', endLocalDateExclusive: '2027-08-03', sellableUnits: 4,
    })).resolves.toMatchObject({ updated: 1 });
    await expect(runtime.database.pool.query(
      'UPDATE booking_availability_room_nights SET sellable_units = 3 WHERE room_type_id = $1 AND local_date = $2',
      [roomType.id, '2027-08-02'],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes overlapping range updates in ascending local-date order without duplicate Room Nights', async () => {
    const runtime = await start();
    const roomType = await createRoomType(runtime);
    await setBasePrice(runtime, roomType.id, 10_000);
    const [first, second] = await Promise.all([
      updateRange(runtime, {
        roomTypeId: roomType.id, startLocalDate: '2027-10-01', endLocalDateExclusive: '2027-10-04', sellableUnits: 4,
      }),
      updateRange(runtime, {
        roomTypeId: roomType.id, startLocalDate: '2027-10-02', endLocalDateExclusive: '2027-10-05', sellableUnits: 2,
      }),
    ]);
    expect(first).toEqual({ updated: 3 });
    expect(second).toEqual({ updated: 3 });
    const rows = (await runtime.database.pool.query(
      'SELECT local_date::text AS local_date, sellable_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date',
      [roomType.id],
    )).rows as Array<{ local_date: string; sellable_units: number }>;
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.local_date)).toEqual([
      '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
    ]);
    expect(new Set(rows.map(row => row.local_date)).size).toBe(4);
    expect(rows[0].sellable_units).toBe(4);
    expect([2, 4]).toContain(rows[1].sellable_units);
    expect(rows[2].sellable_units).toBe(rows[1].sellable_units);
    expect(rows[3].sellable_units).toBe(2);
  });

  it('enforces Availability permissions and uses the caller idempotency key', async () => {
    const runtime = await start();
    const roomType = await createRoomType(runtime);
    await expect(setBasePrice(runtime, roomType.id, 1, actorWith(['booking-availability:read'])))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getRange(runtime, roomType.id, '2027-09-01', '2027-09-02', actorWith(['booking-availability:manage'])))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const key = randomUUID();
    const input = { roomTypeId: roomType.id, baseNightlyPriceMinor: 9_999 };
    await expect(setBasePrice(runtime, roomType.id, 9_999, AVAILABILITY_MANAGER, key)).resolves.toMatchObject(input);
    await expect(setBasePrice(runtime, roomType.id, 9_999, AVAILABILITY_MANAGER, key)).resolves.toMatchObject(input);
  });
});
