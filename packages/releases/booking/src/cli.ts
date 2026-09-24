import { resolveCliProjection, type CliProjectionFactory } from '@storeweave/release/cli';
import { seed } from '../../../../scripts/seeds/booking';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';
import { resolveBookingConfigProjection } from './config';
import { release } from './runtime';

export interface BookingCliProjection {
  readonly release: typeof release;
  readonly seed: typeof seed;
  readonly identity: {
    readonly compatibleReleaseIds: readonly ['booking']; readonly commandName: 'booking';
    readonly servicePrefix: 'booking'; readonly filesystemName: 'booking'; readonly configFilename: string;
  };
  readonly commands: { readonly declared: readonly []; readonly contributions: readonly [] };
}
export const bookingCliProjectionFactory: CliProjectionFactory<BookingCliProjection> = {
  target: 'cli', key: BOOKING_TARGET_KEYS.cli, resolve: () => ({
    release, seed,
    identity: { compatibleReleaseIds: ['booking'], commandName: 'booking', servicePrefix: 'booking', filesystemName: 'booking', configFilename: resolveBookingConfigProjection().defaultFilename },
    commands: { declared: [], contributions: [] },
  }),
};
export function resolveBookingCliProjection(): BookingCliProjection;
export function resolveBookingCliProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<CliProjectionFactory<Contribution>>): Contribution;
export function resolveBookingCliProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<CliProjectionFactory<Contribution>> = bookingCliProjectionFactory as CliProjectionFactory<Contribution>): Contribution {
  return resolveCliProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('cli', bookingFactoryList(factory)));
}
export const cliProjection = resolveBookingCliProjection();
