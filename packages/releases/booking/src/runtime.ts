import { PLATFORM_VERSION } from '@storeweave/contracts';
import { defineRuntimeRelease } from '../../../platform/release/src/runtime';
import { bookingReleaseDefinition } from './definition';
import { bookingConfigProjectionFactory, type BookingConfig } from './config';
import { bookingStorefrontProjectionFactory } from './storefront';
import { BOOKING_EXTENSIONS, BOOKING_ROLES, bookingModules } from './modules';

export const release = defineRuntimeRelease<BookingConfig>(bookingReleaseDefinition, {
  config: bookingConfigProjectionFactory,
  storefront: bookingStorefrontProjectionFactory,
  roles: BOOKING_ROLES,
  legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' }, booking: { reservationPiiRetentionDays: 365, operatorAlertEmail: 'operator@example.test' }, extensions: [{ id: 'mock-payment' }] },
  createModules: ({ config, providers }) => bookingModules(config, providers),
  availableExtensions: BOOKING_EXTENSIONS,
});

if (release.baseVersion !== PLATFORM_VERSION) throw new Error('Booking runtime platform version does not match its ReleaseDefinition');
