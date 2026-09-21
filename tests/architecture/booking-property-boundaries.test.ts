import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createBookingPropertyModule } from '../../packages/booking/property/src/module';
import { bookingPropertyMigrations } from '../../packages/booking/property/src/migrations';

describe('Booking Property ownership boundary', () => {
  it('resolves the package alias through the root TypeScript configuration', () => {
    const root = process.cwd();
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const consumer = resolve(root, 'packages/booking/property/test/types.test.ts');
    const result = ts.resolveModuleName('@storeweave/booking-property', consumer, parsed.options, ts.sys);

    expect(result.resolvedModule?.resolvedFileName).toBe(resolve(root, 'packages/booking/property/src/index.ts'));
  });

  it('owns only Booking Property and Room Type tables and does not persist Commerce, Content, or Media bytes', () => {
    const module = createBookingPropertyModule();
    const migration = bookingPropertyMigrations.migrations.map(entry => entry.up).join('\n');
    const sourceFiles = readdirSync('packages/booking/property/src', { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => join('packages/booking/property/src', entry.name));
    const source = sourceFiles.map(file => readFileSync(file, 'utf8')).join('\n');

    expect(module.data?.owns).toEqual(['booking_property_properties', 'booking_property_room_types']);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_property_properties');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_property_room_types');
    expect(migration).not.toMatch(/\b(?:catalog_|inventory_|order_|content_|platform_media_|platform_storage_)/);
    expect(migration).not.toMatch(/REFERENCES\s+public\.platform_/i);
    expect(source).not.toMatch(/@storeweave\/(?:catalog|inventory|order|customer|content)/);
    expect(readFileSync('packages/booking/property/src/module.ts', 'utf8')).toContain('ports.media');
    expect(readFileSync('packages/booking/property/src/types.ts', 'utf8')).not.toMatch(/\b(?:sku|inventory|stock|nightlyPrice|dateOverride)\b/i);
  });

  it('publishes a narrow versioned read capability for downstream Booking modules', () => {
    expect(createBookingPropertyModule().capabilities?.provides).toContain('booking.property.read.v1');
  });
});
