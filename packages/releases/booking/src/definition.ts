import { PLATFORM_VERSION } from '@storeweave/contracts';
import { validateReleaseDefinition, type ReleaseDefinition, type ReleaseTarget } from '@storeweave/release';
import packageJson from '../package.json';

export const BOOKING_TARGET_KEYS = {
  server: 'booking.server.v1', worker: 'booking.worker.v1', admin: 'booking.admin.v1',
  cli: 'booking.cli.v1', config: 'booking.config.v1', storefront: 'booking.storefront.v1',
} as const satisfies Record<ReleaseTarget, string>;

const SELECTED = {
  modules: ['platform-site', 'content', 'platform-auth', 'booking-property', 'booking-availability', 'booking-reservation'],
  themes: ['booking-default'],
  extensions: ['mock-payment'],
} as const;

/** Portable identity only. Executable contributions live in target subpaths. */
export const bookingReleaseDefinition: ReleaseDefinition = { manifest: {
  id: 'booking',
  version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version,
  selected: SELECTED,
  targets: Object.fromEntries((Object.keys(BOOKING_TARGET_KEYS) as ReleaseTarget[])
    .map(target => [target, { key: BOOKING_TARGET_KEYS[target] }])) as ReleaseDefinition['manifest']['targets'],
  metadata: { baseVersion: PLATFORM_VERSION },
} };

export class BookingReleaseSelectionError extends Error {
  constructor(message: string) { super(`Invalid Booking release selection: ${message}`); this.name = 'BookingReleaseSelectionError'; }
}

export class BookingReleaseContributionError extends Error {
  constructor(message: string) { super(message); this.name = 'BookingReleaseContributionError'; }
}

export function validateBookingReleaseDefinition(definition: unknown): ReleaseDefinition {
  const validated = validateReleaseDefinition(definition);
  if (validated.manifest.id !== 'booking') throw new BookingReleaseSelectionError('release id must be "booking"');
  for (const kind of ['modules', 'themes', 'extensions'] as const) {
    const actual = validated.manifest.selected[kind];
    const expected = SELECTED[kind];
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      throw new BookingReleaseSelectionError(`${kind} must be exactly [${expected.join(', ')}]`);
    }
  }
  for (const target of Object.keys(BOOKING_TARGET_KEYS) as ReleaseTarget[]) {
    if (validated.manifest.targets[target].key !== BOOKING_TARGET_KEYS[target]) {
      throw new BookingReleaseSelectionError(`target "${target}" must use key "${BOOKING_TARGET_KEYS[target]}"`);
    }
  }
  return validated;
}

export type BookingFactoryInput<Factory> = Factory | readonly Factory[];
export function bookingFactoryList<Factory>(input: BookingFactoryInput<Factory>): readonly Factory[] {
  return Array.isArray(input) ? input : [input as Factory];
}
export function requireBookingFactory<Target extends ReleaseTarget, Factory extends { readonly target: Target; readonly key: string }>(
  target: Target, factories: readonly Factory[],
): Factory {
  const key = BOOKING_TARGET_KEYS[target];
  if (factories.length === 0) throw new BookingReleaseContributionError(`Booking projection "${target}" is missing contribution key "${key}"`);
  if (factories.length > 1) throw new BookingReleaseContributionError(`Booking projection "${target}" has duplicate contribution key "${key}"`);
  const factory = factories[0]!;
  if (factory.target !== target) throw new BookingReleaseContributionError(`Booking projection "${target}" received target "${factory.target}" contribution key "${factory.key}"`);
  return factory;
}
