import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  assertThemeCoversPages, type PageRenderer, type ThemeContext,
} from '@storeweave/kernel';
import { createBookingPropertyModule } from '@storeweave/booking-property';
import { bindModuleCapability } from '@storeweave/kernel';
import { createKeyring } from '@storeweave/crypto';
import { createBookingAvailabilityModule, BOOKING_PROPERTY_READ_CAPABILITY } from '@storeweave/booking-availability';
import { bookingPropertyRead } from '@storeweave/booking-property';
import { bookingDefaultTheme } from '../src/index';

const property = {
  id: 'f231e130-5cdf-4e2e-9d01-4e669aebac3e', name: '海岸旅宿',
  address: {
    countryCode: 'TW', postalCode: '970', administrativeArea: '花蓮縣', locality: '花蓮市',
    addressLine1: '中山路 1 號', addressLine2: null,
  },
  timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const roomType = {
  id: 'f231e130-5cdf-4e2e-9d01-4e669aebac3e', code: 'sea-view', name: '海景雙人房',
  description: '面向太平洋的雙人房。', maxOccupancyPerUnit: 2,
  beds: [{ type: 'queen' as const, count: 1 }], amenities: [{ code: 'wifi', label: '無線網路' }],
  minimumStayNights: 1, maximumStayNights: null, mediaAssetId: '44d6a79e-a4fa-4a5e-8d6e-8e6a8275df5d',
  status: 'active' as const,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const quote = {
  roomTypeId: roomType.id, checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03',
  adults: 2, children: 0, roomCount: 1, currency: 'TWD',
  nights: [
    { localDate: '2026-10-01', nightlyPriceMinor: 2_255, nightlyTotalMinor: 1_001 },
    { localDate: '2026-10-02', nightlyPriceMinor: 1_234, nightlyTotalMinor: 3_003 },
  ],
  totalMinor: 7_777,
  cancellationPolicy: { freeCancellationHoursBeforeCheckIn: 48, propertyTimeZone: 'Asia/Taipei', checkInTime: '15:00' },
  fingerprint: `booking-quote-v1:test:${'a'.repeat(64)}`,
};

function bookingAvailabilityModule() {
  const binding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const keyring = createKeyring({
    activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 1).toString('base64url') }],
  });
  return createBookingAvailabilityModule(binding, { maxRoomsPerRequest: 4 }, keyring);
}

const context = (overrides: Partial<ThemeContext> = {}): ThemeContext => ({
  storeName: '海岸旅宿', storeId: 'booking-site', locale: 'zh-TW', timeZone: 'Asia/Taipei',
  publicUrl: 'https://booking.example.test', options: {}, navigation: {}, ...overrides,
});

describe('Booking Default Theme', () => {
  it('renders the Property, active Room Type list, and Room Type detail page models', () => {
    const propertyPage = bookingDefaultTheme.renderers['booking.property.property'](context(), { property });
    const listPage = bookingDefaultTheme.renderers['booking.property.roomTypes'](context(), { property, roomTypes: [roomType] });
    const detailPage = bookingDefaultTheme.renderers['booking.property.roomType'](context(), { property, roomType });

    expect(propertyPage).toContain('<h1>海岸旅宿</h1>');
    expect(propertyPage).toContain('入住時間');
    expect(listPage).toContain('海景雙人房');
    expect(listPage).toContain('/rooms/f231e130-5cdf-4e2e-9d01-4e669aebac3e');
    expect(detailPage).toContain('面向太平洋的雙人房。');
    expect(detailPage).toContain('無線網路');
    expect(detailPage).toContain('每房最多入住 2 人');
    expect(detailPage).toContain('/booking/media/44d6a79e-a4fa-4a5e-8d6e-8e6a8275df5d/preview');
    expect(detailPage).not.toMatch(/nightly|price|availability/i);
  });

  it('escapes supplied Property and Room Type facts and omits absent or malformed Media references', () => {
    const probe = '<img src=x onerror=alert(1)>';
    const unsafeProperty = { ...property, name: probe, address: { ...property.address, addressLine1: probe } };
    const unsafeRoomType = {
      ...roomType, name: probe, description: probe,
      amenities: [{ code: 'probe', label: probe }], mediaAssetId: 'not-a-media-id',
    };
    const html = bookingDefaultTheme.renderers['booking.property.roomType'](context(), {
      property: unsafeProperty, roomType: unsafeRoomType,
    });
    expect(html).not.toContain(probe);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('/booking/media/not-a-media-id/preview');

    const withoutMedia = bookingDefaultTheme.renderers['booking.property.roomType'](context(), {
      property, roomType: { ...roomType, mediaAssetId: null },
    });
    expect(withoutMedia).not.toContain('<figure class="booking-room-image">');
  });

  it('renders Search forms, supplied Quotes, currency, policy, and distinct refreshed terms', () => {
    const initial = bookingDefaultTheme.renderers['booking.availability.search'](context(), {
      kind: 'form', values: { checkInLocalDate: '', checkOutLocalDate: '', adults: '', children: '', roomCount: '' },
    });
    expect(initial).toContain('action="/booking/search" method="get"');
    expect(initial).toContain('name="checkInLocalDate"');

    const results = bookingDefaultTheme.renderers['booking.availability.search'](context(), {
      kind: 'results', choices: [{ roomType: { id: roomType.id, name: '海景房' }, quote }],
    });
    expect(results).toContain('海景房');
    expect(results).toContain('首晚每房每晚 $22.55');
    expect(results).not.toContain('22.55 起');
    expect(results).toContain('name="expectedFingerprint"');
    expect(results).toContain(quote.fingerprint);

    const current = bookingDefaultTheme.renderers['booking.availability.quote'](context(), { kind: 'current', quote });
    expect(current).toContain('10.01');
    expect(current).toContain('30.03');
    expect(current).toContain('77.77');
    expect(current).toContain('48 小時');
    expect(current).toContain('<dd>TWD</dd>');
    expect(current).toContain('Asia/Taipei');
    expect(current).toContain(quote.fingerprint);

    const refreshed = bookingDefaultTheme.renderers['booking.availability.quote'](context(), {
      kind: 'refreshed', quote, expectedFingerprint: `booking-quote-v1:test:${'b'.repeat(64)}`,
    });
    expect(refreshed).toContain('booking-quote-refreshed');
    expect(refreshed).toContain('目前條款與您先前查看的報價不同');
    expect(refreshed).toContain('住宿總額');
  });

  it('escapes Search validation text and renders the typed unavailable states', () => {
    const probe = '<script>alert(1)</script>';
    const validation = bookingDefaultTheme.renderers['booking.availability.search'](context(), {
      kind: 'validation-error', values: { checkInLocalDate: probe, checkOutLocalDate: '', adults: '', children: '', roomCount: '' },
      message: probe,
    });
    expect(validation).not.toContain(probe);
    expect(validation).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(bookingDefaultTheme.renderers['booking.availability.search'](context(), { kind: 'unavailable' }))
      .toContain('目前沒有符合條件且可預訂的房型');
    expect(bookingDefaultTheme.renderers['booking.availability.quote'](context(), { kind: 'unavailable' }))
      .toContain('此房型在所選日期目前無法預訂');
  });

  it('the existing runtime contract names each required renderer missing from the real Booking module', () => {
    const modules = [createBookingPropertyModule(), bookingAvailabilityModule()];
    for (const id of [
      'booking.property.property', 'booking.property.roomTypes', 'booking.property.roomType',
      'booking.availability.search', 'booking.availability.quote',
    ]) {
      const renderers: Record<string, PageRenderer<any>> = { ...bookingDefaultTheme.renderers };
      delete renderers[id];
      expect(() => assertThemeCoversPages(modules, {
        ...bookingDefaultTheme,
        renderers,
      })).toThrow(id);
    }
    expect(() => assertThemeCoversPages(modules, bookingDefaultTheme)).not.toThrow();
  });

  it('bundles no Booking implementation or Commerce executable packages', async () => {
    const bundle = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['packages/themes/booking-default/src/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(bundle.metafile?.inputs ?? {}).map(path => path.replaceAll('\\', '/'));
    expect(inputs.some(path => path.includes('packages/commerce/'))).toBe(false);
    expect(inputs.some(path => path.includes('packages/booking/property/src/'))).toBe(false);
    expect(inputs.some(path => path.includes('packages/booking/availability/src/'))).toBe(false);
  });
});
