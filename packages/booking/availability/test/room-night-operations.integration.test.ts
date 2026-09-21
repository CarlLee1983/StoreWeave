import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, type Actor } from '@storeweave/contracts';
import { bindModuleCapability, createRuntime, resolveKeyring, type Runtime } from '@storeweave/kernel';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  bookingAvailabilityRoomNightOperations,
  type RoomNightOperationInput,
} from '../src/room-night-operations';
import { createBookingAvailabilityModule, BOOKING_PROPERTY_READ_CAPABILITY } from '../src/module';
import { bookingPropertyRead } from '../../property/src/service';
import { createBookingPropertyModule } from '../../property/src/module';

const actorWith = (permissions: string[]): Actor => ({
  id: 'test:booking-room-night-operations', type: 'user', displayName: 'Booking Room Night operations test', permissions,
});
const PROPERTY_MANAGER = actorWith(['booking-property:manage', 'booking-availability:manage']);
const AVAILABILITY_MANAGER = actorWith(['booking-availability:manage']);
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function start() {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_room_night_operations')
    .withUsername('booking')
    .withPassword('booking')
    .start();
  containers.push(container);
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const config = baseConfigSchema.parse({
    version: 1, store: { id: 'booking-room-night-operations', name: 'Booking Room Night Operations Test' },
    database: { url: container.getConnectionUri() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  });
  const secrets = {
    get: (name: string) => name === 'SW_SIGNING_KEY_TEST' ? Buffer.alloc(32, 8).toString('base64url') : undefined,
    has: (name: string) => name === 'SW_SIGNING_KEY_TEST',
    listNames: () => ['SW_SIGNING_KEY_TEST'],
  };
  const keyring = resolveKeyring(config, secrets)!;
  const runtime = await createRuntime({
    release: { id: 'booking-room-night-operations', version: '1.0.0', buildManifestChecksum: `sha256:${'8'.repeat(64)}` },
    roles: BASE_ROLES,
    config, secrets,
    logger: noopLogger, availableExtensions: {},
    modules: [createBookingAvailabilityModule(propertyBinding, { maxRoomsPerRequest: 4 }, keyring), createBookingPropertyModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

async function setUpRoomNightRange(runtime: Runtime, sellableUnits: number, count: number) {
  await runtime.commands.execute('booking.property.create', {
    name: '海角旅店', address: {
      countryCode: 'US', postalCode: '90210', administrativeArea: 'California', locality: 'Los Angeles',
      addressLine1: 'Ocean Avenue 1', addressLine2: null,
    }, timezone: PROPERTY_TIME_ZONE, currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  const roomType = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
    code: 'coast-double', name: '海景雙人房', description: null, maxOccupancyPerUnit: 2,
    beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null,
  }, { actor: PROPERTY_MANAGER, idempotencyKey: randomUUID() });
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
    roomTypeId: roomType.id, baseNightlyPriceMinor: 12_345,
  }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });

  const startLocalDate = addDays(localDate(new Date()), 7);
  const endLocalDateExclusive = addDays(startLocalDate, count);
  await runtime.commands.execute('booking.availability.updateRoomNightRange', {
    roomTypeId: roomType.id, startLocalDate, endLocalDateExclusive, sellableUnits,
  }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });
  return { roomTypeId: roomType.id, startLocalDate, endLocalDateExclusive };
}

function operationInput(
  range: { roomTypeId: string; startLocalDate: string; endLocalDateExclusive: string },
  roomCount = 1,
): RoomNightOperationInput {
  return { ...range, roomCount };
}

async function roomNightCounts(runtime: Runtime, roomTypeId: string) {
  const result = await runtime.database.pool.query<{ localDate: string; sellableUnits: number; reservedUnits: number }>(`
    SELECT local_date::text AS "localDate", sellable_units AS "sellableUnits", reserved_units AS "reservedUnits"
    FROM booking_availability_room_nights WHERE room_type_id = $1 ORDER BY local_date
  `, [roomTypeId]);
  return result.rows;
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

async function waitForBlockedPids(runtime: Runtime, blockingPid: number): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runtime.database.pool.query<{ pid: number; blockers: number[] }>(`
      SELECT pid, pg_catalog.pg_blocking_pids(pid) AS blockers
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
    `);
    const blocked = result.rows
      .filter(row => row.blockers.includes(blockingPid))
      .map(row => Number(row.pid));
    if (blocked.length >= 2) return blocked;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return [];
}

describe('Booking Availability Room Night operations PostgreSQL integration', () => {
  it('reserves and releases every night in the caller transaction, including outer rollback', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 2, 2);
    const input = operationInput(range);
    const now = new Date();

    await expect(runtime.database.transaction(async tx => {
      await expect(bookingAvailabilityRoomNightOperations.reserve(tx, input, now)).resolves.toEqual({ kind: 'reserved' });
      throw new Error('rollback the caller transaction');
    })).rejects.toThrow('rollback the caller transaction');
    expect((await roomNightCounts(runtime, range.roomTypeId)).map(night => night.reservedUnits)).toEqual([0, 0]);

    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.reserve(tx, input, now)))
      .resolves.toEqual({ kind: 'reserved' });
    expect((await roomNightCounts(runtime, range.roomTypeId)).map(night => night.reservedUnits)).toEqual([1, 1]);
    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.release(tx, input, now)))
      .resolves.toEqual({ kind: 'released' });
    expect((await roomNightCounts(runtime, range.roomTypeId)).map(night => night.reservedUnits)).toEqual([0, 0]);
  }, 120_000);

  it('materializes missing nights at zero and reserves nothing when one night is unavailable', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 2, 3);
    const middleNight = addDays(range.startLocalDate, 1);
    await runtime.database.pool.query(
      'DELETE FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2::date',
      [range.roomTypeId, middleNight],
    );

    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.reserve(tx, operationInput(range), new Date())))
      .resolves.toEqual({ kind: 'unavailable' });
    expect(await roomNightCounts(runtime, range.roomTypeId)).toEqual([
      { localDate: range.startLocalDate, sellableUnits: 2, reservedUnits: 0 },
      { localDate: middleNight, sellableUnits: 0, reservedUnits: 0 },
      { localDate: addDays(middleNight, 1), sellableUnits: 2, reservedUnits: 0 },
    ]);
  }, 120_000);

  it('preflights all release nights and leaves a missing or underflowing range unchanged', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 2, 3);
    const firstTwoNights = { ...range, endLocalDateExclusive: addDays(range.startLocalDate, 2) };
    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.reserve(tx, operationInput(firstTwoNights), new Date())))
      .resolves.toEqual({ kind: 'reserved' });

    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.release(tx, operationInput(range), new Date())))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await roomNightCounts(runtime, range.roomTypeId)).map(night => night.reservedUnits)).toEqual([1, 1, 0]);

    const lastNight = addDays(range.startLocalDate, 2);
    await runtime.database.pool.query(
      'DELETE FROM booking_availability_room_nights WHERE room_type_id = $1 AND local_date = $2::date',
      [range.roomTypeId, lastNight],
    );
    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.release(tx, operationInput(range), new Date())))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const rows = await roomNightCounts(runtime, range.roomTypeId);
    expect(rows).toHaveLength(2);
    expect(rows.map(night => night.reservedUnits)).toEqual([1, 1]);
  }, 120_000);

  it('serializes concurrent attempts for the final unit and holds locks until caller commit', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 1, 2);
    const input = operationInput(range);
    const releaseFirst = deferred();
    const firstHasReserved = deferred<number>();
    const secondIsWaiting = deferred<number>();
    const now = new Date();

    const first = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      const result = await bookingAvailabilityRoomNightOperations.reserve(tx, input, now);
      firstHasReserved.resolve(pid);
      await releaseFirst.promise;
      return result;
    });

    const firstPid = await firstHasReserved.promise;
    let secondSettled = false;
    const second = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      secondIsWaiting.resolve(pid);
      const result = await bookingAvailabilityRoomNightOperations.reserve(tx, input, now);
      secondSettled = true;
      return result;
    });

    let blocked = false;
    try {
      const secondPid = await secondIsWaiting.promise;
      blocked = await waitForBlocker(runtime, secondPid, firstPid);
      expect(secondSettled).toBe(false);
    } finally {
      releaseFirst.resolve();
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(blocked).toBe(true);
    expect(firstResult).toEqual({ kind: 'reserved' });
    expect(secondResult).toEqual({ kind: 'unavailable' });
    expect((await roomNightCounts(runtime, range.roomTypeId)).map(night => night.reservedUnits)).toEqual([1, 1]);
  }, 120_000);

  it('completes overlapping reserve, release, and sellable-unit updates without deadlock or capacity drift', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 2, 4);
    await expect(runtime.database.transaction(tx => bookingAvailabilityRoomNightOperations.reserve(tx, operationInput(range), new Date())))
      .resolves.toEqual({ kind: 'reserved' });

    const firstThree = { ...range, endLocalDateExclusive: addDays(range.startLocalDate, 3) };
    const middleThree = { ...range, startLocalDate: addDays(range.startLocalDate, 1), endLocalDateExclusive: range.endLocalDateExclusive };
    const releaseFirst = deferred();
    const reserveHasLocked = deferred<number>();
    const releaseIsWaiting = deferred<number>();
    const first = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      const result = await bookingAvailabilityRoomNightOperations.reserve(tx, operationInput(firstThree), new Date());
      reserveHasLocked.resolve(pid);
      await releaseFirst.promise;
      return result;
    });

    const firstPid = await reserveHasLocked.promise;
    const release = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      releaseIsWaiting.resolve(pid);
      return bookingAvailabilityRoomNightOperations.release(tx, operationInput(middleThree), new Date());
    });
    const releasePid = await releaseIsWaiting.promise;
    const admin = runtime.commands.execute('booking.availability.updateRoomNightRange', {
      ...range, sellableUnits: 2,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });

    let blockedPids: number[] = [];
    try {
      blockedPids = await waitForBlockedPids(runtime, firstPid);
    } finally {
      releaseFirst.resolve();
    }

    const [reserveResult, releaseResult] = await Promise.all([first, release]);
    await admin;
    expect(blockedPids).toContain(releasePid);
    expect(blockedPids.filter(pid => pid !== releasePid)).toHaveLength(1);
    expect(reserveResult).toEqual({ kind: 'reserved' });
    expect(releaseResult).toEqual({ kind: 'released' });
    const nights = await roomNightCounts(runtime, range.roomTypeId);
    expect(nights).toHaveLength(4);
    expect(nights.map(night => night.reservedUnits)).toEqual([2, 1, 1, 0]);
    expect(nights.every(night => night.sellableUnits === 2 && night.reservedUnits <= night.sellableUnits)).toBe(true);
  }, 120_000);

  it('serializes concurrent multi-night materialization against an overlapping admin update', async () => {
    const runtime = await start();
    const range = await setUpRoomNightRange(runtime, 2, 4);
    await runtime.database.pool.query(
      'DELETE FROM booking_availability_room_nights WHERE room_type_id = $1', [range.roomTypeId],
    );

    const releaseTableLock = deferred();
    const tableLockAcquired = deferred<number>();
    const reserveStarted = deferred<number>();
    const blocker = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      await tx.execute(sql`LOCK TABLE booking_availability_room_nights IN SHARE ROW EXCLUSIVE MODE`);
      tableLockAcquired.resolve(pid);
      await releaseTableLock.promise;
    });
    const blockerPid = await tableLockAcquired.promise;
    const reserve = runtime.database.transaction(async tx => {
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      reserveStarted.resolve(pid);
      return bookingAvailabilityRoomNightOperations.reserve(tx, operationInput(range), new Date());
    });
    const reservePid = await reserveStarted.promise;
    const admin = runtime.commands.execute('booking.availability.updateRoomNightRange', {
      ...range, sellableUnits: 2,
    }, { actor: AVAILABILITY_MANAGER, idempotencyKey: randomUUID() });

    let blockedPids: number[] = [];
    try {
      blockedPids = await waitForBlockedPids(runtime, blockerPid);
    } finally {
      releaseTableLock.resolve();
    }

    const reserveResult = await reserve;
    await expect(admin).resolves.toMatchObject({ updated: 4 });
    await blocker;
    expect(blockedPids).toHaveLength(2);
    expect(new Set(blockedPids).size).toBe(2);
    expect(blockedPids).toContain(reservePid);
    const nights = await roomNightCounts(runtime, range.roomTypeId);
    expect(nights).toHaveLength(4);
    expect(nights.map(night => night.localDate)).toEqual([
      range.startLocalDate,
      addDays(range.startLocalDate, 1),
      addDays(range.startLocalDate, 2),
      addDays(range.startLocalDate, 3),
    ]);
    expect(nights.every(night => night.sellableUnits === 2 && night.reservedUnits <= night.sellableUnits)).toBe(true);
    expect(nights.map(night => night.reservedUnits)).toEqual(
      reserveResult.kind === 'reserved' ? [1, 1, 1, 1] : [0, 0, 0, 0],
    );
  }, 120_000);

  it('exports the exact capability key for a future Reservation binding', () => {
    expect(BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY).toBe('booking.availability.room-night-operations.v1');
  });
});
