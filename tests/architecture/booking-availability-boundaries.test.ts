import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { bookingPropertyRead } from '../../packages/booking/property/src/service';
import {
  bindBookingAvailabilityQuoteReservation, createBookingAvailabilityModule,
  BOOKING_AVAILABILITY_QUOTE_CAPABILITY, BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
  BOOKING_PROPERTY_READ_CAPABILITY,
} from '../../packages/booking/availability/src/module';
import { bookingAvailabilityMigrations } from '../../packages/booking/availability/src/migrations';
import { bindModuleCapability } from '@storeweave/kernel';
import { createKeyring } from '@storeweave/crypto';

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('Booking Availability module boundary', () => {
  it('owns its two Availability tables and requires Property read through its declared capability', () => {
    const binding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
    const quoteSigningKeyring = createKeyring({
      activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 1).toString('base64url') }],
    });
    const module = createBookingAvailabilityModule(binding, { maxRoomsPerRequest: 4 }, quoteSigningKeyring);
    const quoteReservationBinding = bindBookingAvailabilityQuoteReservation(binding, { maxRoomsPerRequest: 4 }, quoteSigningKeyring);
    expect(module.data?.owns).toEqual(['booking_availability_room_type_prices', 'booking_availability_room_nights']);
    expect(module.capabilities?.provides).toContain(BOOKING_AVAILABILITY_QUOTE_CAPABILITY);
    expect(module.capabilities?.provides).toContain(BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY);
    expect(quoteReservationBinding).toMatchObject({
      from: 'booking-availability', capability: BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
    });
    expect(module.migrations).toEqual(bookingAvailabilityMigrations);
    expect(module.dependencies?.required).toContainEqual({ name: 'booking-property', versionRange: '^0.1.0' });
    expect(module.capabilities?.required).toContainEqual({
      from: 'booking-property', capability: BOOKING_PROPERTY_READ_CAPABILITY, versionRange: '^0.1.0',
    });
    expect(module.capabilities?.bound).toContain(binding);
    expect(bookingAvailabilityMigrations.module).toBe('booking-availability');
    expect(bookingAvailabilityMigrations.migrations.map(migration => migration.id)).toEqual(['0001_room_night_administration']);
    expect(module.permissions?.map(permission => permission.key)).toContain('booking-availability:quote');
    expect(module.queries?.map(query => query.descriptor.name)).toContain('booking.availability.getQuote');
    expect(module.queries?.map(query => query.descriptor.name)).toContain('booking.availability.searchQuotes');
    expect(Object.values(module.pages ?? {}).map(page => [page.id, page.path])).toEqual([
      ['booking.availability.search', '/booking/search'],
      ['booking.availability.quote', '/booking/quote'],
    ]);
  });

  it('resolves the package alias to its public module entrypoint', () => {
    const config = ts.readConfigFile(join(ROOT, 'tsconfig.base.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const resolved = ts.resolveModuleName('@storeweave/booking-availability', resolve(ROOT, 'tests/architecture/booking-availability-boundaries.test.ts'), parsed.options, ts.sys);
    expect(resolved.resolvedModule?.resolvedFileName).toBe(resolve(ROOT, 'packages/booking/availability/src/index.ts'));
  });

  it('keeps Booking Availability executable imports and foreign table references inside its owned module seam', () => {
    const files = sourceFiles('packages/booking/availability/src');
    const source = files.map(path => readFileSync(join(ROOT, path), 'utf8')).join('\n');
    expect(files.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/@storeweave\/(?:booking-reservation|commerce|order|cart|inventory|theme|admin)/);
    expect(source).not.toMatch(/REFERENCES\s+(?:public\.)?booking_property_/i);
    expect(source).not.toMatch(/(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?booking_property_/i);
    expect(readFileSync(join(ROOT, 'packages/booking/availability/src/schema.ts'), 'utf8')).not.toMatch(/pgTable\(['"]booking_availability_quotes/);
    expect(source).toContain("'booking-availability:manage'");
  });
});
