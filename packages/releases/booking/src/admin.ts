import { resolveAdminProjection, type AdminProjectionFactory } from '@storeweave/release/admin';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';

/** SW-143 will add Admin contributions; the platform requires a declared target today. */
export interface BookingAdminProjection { readonly enabled: false; readonly contributions: readonly [] }
export const bookingAdminProjectionFactory: AdminProjectionFactory<BookingAdminProjection> = {
  target: 'admin', key: BOOKING_TARGET_KEYS.admin, resolve: () => ({ enabled: false, contributions: [] }),
};
export function resolveBookingAdminProjection(): BookingAdminProjection;
export function resolveBookingAdminProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<AdminProjectionFactory<Contribution>>): Contribution;
export function resolveBookingAdminProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<AdminProjectionFactory<Contribution>> = bookingAdminProjectionFactory as AdminProjectionFactory<Contribution>): Contribution {
  return resolveAdminProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('admin', bookingFactoryList(factory)));
}
