import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, type Actor } from '@storeweave/contracts';
import { bindModuleCapability, createRuntime, resolveKeyring, type Runtime } from '@storeweave/kernel';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterEach, describe, expect, it } from 'vitest';
import { createBookingAvailabilityModule, BOOKING_PROPERTY_READ_CAPABILITY } from '../src/module';
import { bookingPropertyRead } from '../../property/src/service';
import { createBookingPropertyModule } from '../../property/src/module';

const actorWith = (permissions: string[]): Actor => ({
  id: 'test:booking-quote', type: 'user', displayName: 'booking quote test', permissions,
});
const PROPERTY_MANAGER = actorWith(['booking-property:manage', 'booking-availability:manage']);
const AVAILABILITY_MANAGER = actorWith(['booking-availability:manage']);
const QUOTE_ACTOR = actorWith(['booking-availability:quote']);
const BOOKING_TEST_ROLES = {
  ...BASE_ROLES,
  visitor: {
    ...BASE_ROLES.visitor,
    permissions: [...BASE_ROLES.visitor.permissions, 'booking-availability:quote'],
  },
};
const PROPERTY_TIME_ZONE = 'America/Los_Angeles';
const runtimes: Runtime[] = [];
const containers: StartedPostgreSqlContainer[] = [];

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
    .withDatabase('booking_availability_quote')
    .withUsername('booking')
    .withPassword('booking')
    .start();
  containers.push(container);
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-availability-quote-test', name: 'Booking Availability Quote Test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = {
    get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? Buffer.alloc(32, 6).toString('base64url') : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
    listNames: () => ['SW_SIGNING_KEY_TEST'],
  };
  const keyring = resolveKeyring(config, secrets)!;
  const runtime = await createRuntime({
    release: { id: 'booking-availability-quote-test', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
    roles: BOOKING_TEST_ROLES,
    config, secrets,
    logger: noopLogger, availableExtensions: {},
    modules: [createBookingAvailabilityModule(
      propertyBinding,
      { maxRoomsPerRequest: 4 },
      keyring,
    ), createBookingPropertyModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

describe('Booking Availability Quote PostgreSQL integration', () => {
  it('quotes fallback and override prices from one current supply snapshot without persisting a hold', async () => {
    const runtime = await start();
    await runtime.commands.execute('booking.property.create', {
      name: '海角旅店', address: {
        countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles',
        addressLine1: 'Ocean Avenue 1', addressLine2: null,
      }, timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
    }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
    const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
      code: 'coast-double', name: '海景雙人房', description: null, maxOccupancyPerUnit: 2,
      beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null,
    }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
    await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
      roomTypeId: room.id, baseNightlyPriceMinor: 12_345,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });

    const checkInLocalDate = addDays(localDate(new Date()), 7);
    const checkOutLocalDate = addDays(checkInLocalDate, 2);
    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId: room.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate,
      sellableUnits: 3,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId: room.id, startLocalDate: addDays(checkInLocalDate, 1), endLocalDateExclusive: checkOutLocalDate,
      nightlyPriceOverrideMinor: 20_000,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });

    const input = { roomTypeId: room.id, checkInLocalDate, checkOutLocalDate, adults: 2, children: 1, roomCount: 2 };
    const quote = await runtime.queries.execute<{
      kind: 'available' | 'unavailable';
      quote?: {
        currency: string;
        totalMinor: number;
        nights: { localDate: string; nightlyPriceMinor: number; nightlyTotalMinor: number }[];
        cancellationPolicy: { freeCancellationHoursBeforeCheckIn: number; propertyTimeZone: string; checkInTime: string };
        fingerprint: string;
      };
    }>('booking.availability.getQuote', input, { actor: QUOTE_ACTOR });
    expect(quote).toMatchObject({
      kind: 'available',
      quote: {
        currency: 'USD', totalMinor: 64_690,
        nights: [
          { localDate: checkInLocalDate, nightlyPriceMinor: 12_345, nightlyTotalMinor: 24_690 },
          { localDate: addDays(checkInLocalDate, 1), nightlyPriceMinor: 20_000, nightlyTotalMinor: 40_000 },
        ],
        cancellationPolicy: {
          freeCancellationHoursBeforeCheckIn: 48, propertyTimeZone: PROPERTY_TIME_ZONE, checkInTime: '15:00',
        },
        fingerprint: expect.stringMatching(/^booking-quote-v1:test:[0-9a-f]{64}$/),
      },
    });
    const repeated = await runtime.queries.execute('booking.availability.getQuote', input, { actor: QUOTE_ACTOR });
    expect(repeated).toEqual(quote);
    expect(JSON.stringify(quote)).not.toContain('availableUnits');
    expect((await runtime.database.pool.query(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date', [room.id],
    )).rows).toEqual([{ reserved_units: 0 }, { reserved_units: 0 }]);

    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId: room.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate, sellableUnits: 4,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    const afterSupplyChange = await runtime.queries.execute<{
      kind: 'available' | 'unavailable'; quote?: { fingerprint: string };
    }>('booking.availability.getQuote', input, { actor: QUOTE_ACTOR });
    expect(afterSupplyChange.kind).toBe('available');
    if (quote.kind !== 'available' || !quote.quote || afterSupplyChange.kind !== 'available' || !afterSupplyChange.quote) {
      throw new Error('Expected an available Quote');
    }
    expect(afterSupplyChange.quote?.fingerprint).not.toBe(quote.quote.fingerprint);

    await runtime.commands.execute('booking.availability.updateRoomNightRange', {
      roomTypeId: room.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate, sellableUnits: 2,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    const insufficient = await runtime.queries.execute('booking.availability.getQuote', { ...input, roomCount: 3, adults: 3 }, { actor: QUOTE_ACTOR });
    expect(insufficient).toEqual({ kind: 'unavailable' });
    expect((await runtime.database.pool.query(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date', [room.id],
    )).rows).toEqual([{ reserved_units: 0 }, { reserved_units: 0 }]);
  }, 120_000);

  it('searches active Room Types in Property order and returns only available server-produced Quotes', async () => {
    const runtime = await start();
    await runtime.commands.execute('booking.property.create', {
      name: '海角旅店', address: {
        countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles',
        addressLine1: 'Ocean Avenue 1', addressLine2: null,
      }, timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
    }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });

    const createRoom = (name: string, code: string, values: { maxOccupancyPerUnit?: number; minimumStayNights?: number } = {}) =>
      runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
        code, name, description: null, maxOccupancyPerUnit: values.maxOccupancyPerUnit ?? 2,
        beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: values.minimumStayNights ?? 1,
        maximumStayNights: null, mediaAssetId: null,
      }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
    const first = await createRoom('A 海景房', 'a-sea-view');
    const tooShort = await createRoom('B 長住房', 'b-long-stay', { minimumStayNights: 3 });
    const tooSmall = await createRoom('C 單人房', 'c-single', { maxOccupancyPerUnit: 1 });
    const second = await createRoom('D 花園房', 'd-garden');
    const soldOut = await createRoom('E 客滿房', 'e-sold-out');

    const checkInLocalDate = addDays(localDate(new Date()), 7);
    const checkOutLocalDate = addDays(checkInLocalDate, 2);
    for (const [room, nightlyPrice] of [[first, 12_000], [second, 15_000], [soldOut, 9_000]] as const) {
      await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
        roomTypeId: room.id, baseNightlyPriceMinor: nightlyPrice,
      }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    }
    for (const room of [first, second]) {
      await runtime.commands.execute('booking.availability.updateRoomNightRange', {
        roomTypeId: room.id, startLocalDate: checkInLocalDate, endLocalDateExclusive: checkOutLocalDate,
        sellableUnits: 2,
      }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
    }

    const request = {
      checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1,
    };
    await expect(runtime.queries.execute('booking.availability.searchQuotes', request, {
      actor: runtime.actorForRole('member'),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const choices = await runtime.queries.execute<{
      kind: 'available' | 'unavailable';
      choices?: Array<{ roomType: { id: string; name: string }; quote: { roomTypeId: string; fingerprint: string } }>;
    }>('booking.availability.searchQuotes', request, { actor: runtime.actorForRole('visitor') });

    expect(choices).toMatchObject({ kind: 'available', choices: [
      { roomType: { id: first.id, name: 'A 海景房' }, quote: { roomTypeId: first.id } },
      { roomType: { id: second.id, name: 'D 花園房' }, quote: { roomTypeId: second.id } },
    ] });
    expect(choices.choices?.every(choice => /^booking-quote-v1:test:[0-9a-f]{64}$/.test(choice.quote.fingerprint))).toBe(true);
    expect(choices.choices?.map(choice => choice.roomType.id)).not.toContain(tooShort.id);
    expect(choices.choices?.map(choice => choice.roomType.id)).not.toContain(tooSmall.id);
    expect(choices.choices?.map(choice => choice.roomType.id)).not.toContain(soldOut.id);

    expect((await runtime.database.pool.query(
      'SELECT room_type_id, local_date::text AS local_date, reserved_units FROM booking_availability_room_nights ORDER BY room_type_id, local_date',
    )).rows).toHaveLength(4);
    expect((await runtime.database.pool.query(
      'SELECT reserved_units FROM booking_availability_room_nights WHERE reserved_units <> 0',
    )).rows).toEqual([]);
  }, 120_000);
});
