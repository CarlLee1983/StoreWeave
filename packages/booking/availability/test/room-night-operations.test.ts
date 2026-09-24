import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { bindModuleCapability } from '@storeweave/kernel';
import { createKeyring } from '@storeweave/crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bookingPropertyRead } from '../../property/src/service';
import {
  BOOKING_PROPERTY_READ_CAPABILITY,
  createBookingAvailabilityModule,
} from '../src/module';
import {
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  createBookingAvailabilityRoomNightOperations,
  type RoomNightOperationInput,
} from '../src/room-night-operations';
import type { BookingAvailabilityRoomNightRow } from '../src/schema';

const ROOM_TYPE_ID = '81a8ae9d-5096-48b8-8b59-af3c7a14ce02';
const TX = {} as Tx;
const NOW = new Date('2026-09-20T12:00:00.000Z');

function input(values: Partial<RoomNightOperationInput> = {}): RoomNightOperationInput {
  return {
    roomTypeId: ROOM_TYPE_ID,
    startLocalDate: '2026-09-25',
    endLocalDateExclusive: '2026-09-27',
    roomCount: 1,
    ...values,
  };
}

function night(localDate: string, sellableUnits: number, reservedUnits: number): BookingAvailabilityRoomNightRow {
  return {
    roomTypeId: ROOM_TYPE_ID,
    localDate,
    sellableUnits,
    reservedUnits,
    nightlyPriceOverrideMinor: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function basePrice() {
  return { roomTypeId: ROOM_TYPE_ID, baseNightlyPriceMinor: 10_000, createdAt: NOW, updatedAt: NOW };
}

function repository(rows: BookingAvailabilityRoomNightRow[] = [
  night('2026-09-25', 2, 0), night('2026-09-26', 2, 0),
]) {
  return {
    getBasePrice: vi.fn().mockResolvedValue(basePrice()),
    materializeRoomNightsInDateOrder: vi.fn().mockResolvedValue(undefined),
    lockRoomNights: vi.fn().mockResolvedValue(rows),
    adjustReservedUnits: vi.fn().mockResolvedValue(rows.length),
  };
}

describe('Booking Availability Room Night operations', () => {
  it('validates reserve and release inputs before any database access', async () => {
    const repo = repository();
    const operations = createBookingAvailabilityRoomNightOperations(repo);
    const invalid = [
      input({ roomTypeId: 'bad-id' } as Partial<RoomNightOperationInput>),
      input({ startLocalDate: '2026-02-30' }),
      input({ endLocalDateExclusive: '2026-09-25' }),
      input({ startLocalDate: '2026-09-25', endLocalDateExclusive: '2026-10-26' }),
      input({ roomCount: 0 }),
      input({ roomCount: 2_147_483_648 }),
    ];

    for (const request of invalid) {
      await expect(operations.reserve(TX, request, NOW)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(operations.release(TX, request, NOW)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(operations.reserve(TX, input(), new Date(Number.NaN))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(operations.release(TX, input(), new Date(Number.NaN))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repo.getBasePrice).not.toHaveBeenCalled();
    expect(repo.materializeRoomNightsInDateOrder).not.toHaveBeenCalled();
    expect(repo.lockRoomNights).not.toHaveBeenCalled();
    expect(repo.adjustReservedUnits).not.toHaveBeenCalled();
  });

  it('materializes then locks in date order, preflights all nights, and only then reserves', async () => {
    const repo = repository();
    const operations = createBookingAvailabilityRoomNightOperations(repo);

    await expect(operations.reserve(TX, input({ roomCount: 2 }), NOW)).resolves.toEqual({ kind: 'reserved' });
    expect(repo.materializeRoomNightsInDateOrder).toHaveBeenCalledWith(TX, ROOM_TYPE_ID, ['2026-09-25', '2026-09-26'], NOW);
    expect(repo.lockRoomNights).toHaveBeenCalledWith(TX, ROOM_TYPE_ID, ['2026-09-25', '2026-09-26']);
    expect(repo.adjustReservedUnits).toHaveBeenCalledWith(TX, ROOM_TYPE_ID, ['2026-09-25', '2026-09-26'], 2, NOW);
  });

  it('returns unavailable when any night lacks capacity without changing any reserved count', async () => {
    const repo = repository([
      night('2026-09-25', 2, 0), night('2026-09-26', 1, 1),
    ]);
    const operations = createBookingAvailabilityRoomNightOperations(repo);

    await expect(operations.reserve(TX, input(), NOW)).resolves.toEqual({ kind: 'unavailable' });
    expect(repo.adjustReservedUnits).not.toHaveBeenCalled();
  });

  it('does not materialize or alter rows when the Availability base price is missing', async () => {
    const repo = repository();
    repo.getBasePrice.mockResolvedValue(null);
    const operations = createBookingAvailabilityRoomNightOperations(repo);

    await expect(operations.reserve(TX, input(), NOW)).resolves.toEqual({ kind: 'unavailable' });
    expect(repo.materializeRoomNightsInDateOrder).not.toHaveBeenCalled();
    expect(repo.lockRoomNights).not.toHaveBeenCalled();
    expect(repo.adjustReservedUnits).not.toHaveBeenCalled();
  });

  it('releases only after the complete existing range has enough reserved units', async () => {
    const repo = repository([
      night('2026-09-25', 2, 1), night('2026-09-26', 2, 1),
    ]);
    const operations = createBookingAvailabilityRoomNightOperations(repo);

    await expect(operations.release(TX, input(), NOW)).resolves.toEqual({ kind: 'released' });
    expect(repo.getBasePrice).not.toHaveBeenCalled();
    expect(repo.materializeRoomNightsInDateOrder).not.toHaveBeenCalled();
    expect(repo.lockRoomNights).toHaveBeenCalledWith(TX, ROOM_TYPE_ID, ['2026-09-25', '2026-09-26']);
    expect(repo.adjustReservedUnits).toHaveBeenCalledWith(TX, ROOM_TYPE_ID, ['2026-09-25', '2026-09-26'], -1, NOW);
  });

  it('rejects missing or underflowing release ranges before decrementing any night', async () => {
    const repo = repository([
      night('2026-09-25', 2, 1), night('2026-09-26', 2, 0),
    ]);
    const operations = createBookingAvailabilityRoomNightOperations(repo);

    await expect(operations.release(TX, input(), NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repo.adjustReservedUnits).not.toHaveBeenCalled();

    repo.lockRoomNights.mockResolvedValue([night('2026-09-25', 2, 1)]);
    await expect(operations.release(TX, input(), NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repo.adjustReservedUnits).not.toHaveBeenCalled();
  });

  it('declares a stable supply-only capability with no foreign Product or Quote dependency', () => {
    const binding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
    const keyring = createKeyring({ activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 3).toString('base64url') }] });
    const module = createBookingAvailabilityModule(binding, { maxRoomsPerRequest: 4 }, keyring);
    expect(module.capabilities?.provides).toContain(BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY);

    const source = readFileSync('packages/booking/availability/src/room-night-operations.ts', 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*(?:booking-reservation|commerce|payment|order|cart)/);
    expect(source).not.toMatch(/(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?booking_property_/i);
    expect(source).not.toMatch(/fingerprint|reservationId|booking-reservation/i);
  });
});
