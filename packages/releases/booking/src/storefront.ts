import { bookingDefaultTheme } from '@storeweave/theme-booking-default';
import { resolveStorefrontProjection, type StorefrontProjectionFactory } from '@storeweave/release/storefront';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';

export interface BookingStorefrontProjection { readonly themes: { readonly 'booking-default': typeof bookingDefaultTheme } }
export const bookingStorefrontProjectionFactory: StorefrontProjectionFactory<BookingStorefrontProjection> & { readonly source: string } = {
  target: 'storefront', key: BOOKING_TARGET_KEYS.storefront, source: 'packages/releases/booking/src/storefront.ts',
  resolve: () => ({ themes: { 'booking-default': bookingDefaultTheme } }),
};
export function resolveBookingStorefrontProjection(): BookingStorefrontProjection;
export function resolveBookingStorefrontProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<StorefrontProjectionFactory<Contribution>>): Contribution;
export function resolveBookingStorefrontProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<StorefrontProjectionFactory<Contribution>> = bookingStorefrontProjectionFactory as unknown as StorefrontProjectionFactory<Contribution>): Contribution {
  return resolveStorefrontProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('storefront', bookingFactoryList(factory)));
}
