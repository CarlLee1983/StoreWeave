import { describe, expect, it } from 'vitest';
import { noopLogger } from '@storeweave/contracts';
import { createKeyring } from '@storeweave/crypto';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { assertThemeCoversPages } from '@storeweave/kernel';
import { buildReleaseManifest } from '@storeweave/release/runtime';
import { seed } from '../../../../scripts/seeds/booking';
import { BOOKING_TARGET_KEYS, BookingReleaseContributionError, bookingReleaseDefinition } from '../src';
import { resolveBookingAdminProjection } from '../src/admin';
import { resolveBookingCliProjection } from '../src/cli';
import { bookingConfigDefinition, resolveBookingConfigProjection } from '../src/config';
import { release } from '../src/runtime';
import { httpAdapter, resolveBookingServerProjection } from '../src/server';
import { resolveBookingStorefrontProjection } from '../src/storefront';
import { resolveBookingWorkerProjection } from '../src/worker';

describe('Booking release assembly', () => {
  it('keeps the root serializable and resolves each target contribution', () => {
    expect(JSON.parse(JSON.stringify(bookingReleaseDefinition))).toEqual(bookingReleaseDefinition);
    expect(Object.keys(bookingReleaseDefinition)).toEqual(['manifest']);
    expect(bookingReleaseDefinition.manifest.targets).toEqual(Object.fromEntries(
      Object.entries(BOOKING_TARGET_KEYS).map(([target, key]) => [target, { key }]),
    ));
    expect(resolveBookingServerProjection()).toEqual({ release, httpAdapter });
    expect(resolveBookingWorkerProjection()).toEqual({ target: 'worker', release });
    expect(resolveBookingAdminProjection()).toEqual({ enabled: false, contributions: [] });
    expect(resolveBookingCliProjection()).toMatchObject({ release, seed, identity: { configFilename: 'booking.yaml' }, commands: { declared: [] } });
    expect(resolveBookingConfigProjection()).toEqual({ definition: bookingConfigDefinition, defaultFilename: 'booking.yaml' });
    expect(Object.keys(resolveBookingStorefrontProjection().themes)).toEqual(['booking-default']);
  });

  it('selects the complete modules, Theme, and refund-qualified Extension', () => {
    const config = release.config.schema.parse(release.manifestConfig);
    const modules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
    expect(modules.map(module => module.name)).toEqual(bookingReleaseDefinition.manifest.selected.modules);
    expect(Object.keys(release.availableThemes)).toEqual(bookingReleaseDefinition.manifest.selected.themes);
    expect(Object.keys(release.availableExtensions)).toEqual(bookingReleaseDefinition.manifest.selected.extensions);
    expect(release.availableExtensions['mock-payment']?.manifest.id).toBe('mock-payment');
    expect(() => assertThemeCoversPages(modules, release.availableThemes['booking-default']!)).not.toThrow();
    const selectedTheme = release.availableThemes['booking-default']!;
    const missingRenderer = {
      ...selectedTheme,
      renderers: Object.fromEntries(Object.entries(selectedTheme.renderers).filter(([key]) => key !== 'booking.availability.quote')),
    } as typeof selectedTheme;
    expect(() => assertThemeCoversPages(modules, missingRenderer)).toThrow('booking.availability.quote');
    expect(buildReleaseManifest(release).modules.find(module => module.id === 'booking-reservation')?.signingKeyPurposes)
      .toEqual(['booking-reservation-access-grant', 'booking-reservation-checkout-credential']);
  });

  it('requires a configured qualified payment Extension and retention policy', () => {
    const valid = release.manifestConfig as Record<string, unknown>;
    expect(() => bookingConfigDefinition.schema.parse({ ...valid, booking: {} })).toThrow();
    expect(() => bookingConfigDefinition.schema.parse({ ...valid, extensions: [] })).toThrow('refund-qualified payment Extension');
    expect(() => bookingConfigDefinition.schema.parse({ ...valid, extensions: [{ id: 'ecpay' }] })).toThrow('refund-qualified payment Extension');
    expect(() => bookingConfigDefinition.schema.parse({ ...valid, extensions: [{ id: 'mock-payment', enabled: false }] })).toThrow('refund-qualified payment Extension');
  });

  it('fails missing, duplicate, and foreign target contributions before executing them', () => {
    let executed = false;
    const factory = { target: 'server' as const, key: BOOKING_TARGET_KEYS.server, resolve: () => { executed = true; return {}; } };
    expect(() => resolveBookingServerProjection(bookingReleaseDefinition, [])).toThrow(
      new BookingReleaseContributionError('Booking projection "server" is missing contribution key "booking.server.v1"'),
    );
    expect(() => resolveBookingServerProjection(bookingReleaseDefinition, [factory, factory])).toThrow(
      new BookingReleaseContributionError('Booking projection "server" has duplicate contribution key "booking.server.v1"'),
    );
    expect(() => resolveBookingServerProjection(bookingReleaseDefinition, { ...factory, key: 'commerce.server.v1' }))
      .toThrow('Release target "server" requires factory key "booking.server.v1"');
    expect(executed).toBe(false);
    expect(() => resolveBookingWorkerProjection(bookingReleaseDefinition, [])).toThrow('booking.worker.v1');
    expect(() => resolveBookingCliProjection(bookingReleaseDefinition, [])).toThrow('booking.cli.v1');
    expect(() => resolveBookingStorefrontProjection(bookingReleaseDefinition, [])).toThrow('booking.storefront.v1');
  });

  it('requires Reservation signing security at runtime', () => {
    const config = release.config.schema.parse(release.manifestConfig);
    const modules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
    const reservation = modules.find(module => module.name === 'booking-reservation')!;
    expect(() => reservation.bindRuntimeSecurity?.({})).toThrow('configured signing Keyring');
    const second = release.createModules({ config, providers: new ProviderRegistry(noopLogger) })
      .find(module => module.name === 'booking-reservation')!;
    const keyring = createKeyring({ activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 17).toString('base64url') }] });
    second.bindRuntimeSecurity?.({ keyring });
    expect(() => second.bindRuntimeSecurity?.({ keyring })).toThrow('may only be bound once');
  });
});
