import packageJson from '../package.json';
import {
  bindModuleCapability, type BoundModuleCapability, defineModule,
  type PlatformModule, type RuntimeSecurity,
} from '@storeweave/kernel';
import type { Keyring } from '@storeweave/crypto';
import {
  createSetBaseNightlyPriceHandler, createUpdateRoomNightRangeHandler,
  setBaseNightlyPriceCommand, updateRoomNightRangeCommand,
} from './commands';
import { bookingAvailabilityMigrations } from './migrations';
import {
  createBookingAvailabilityQuote, createGetBookingQuoteHandler, getBookingQuoteQuery,
  type BookingAvailabilityQuoteCapability, type BookingQuoteLimits,
} from './quote';
import {
  createBookingAvailabilitySearch, createSearchBookingQuotesHandler, searchBookingQuotesQuery,
  type BookingAvailabilitySearchCapability,
} from './search';
import { bookingAvailabilityPages } from './pages';
import { createGetRoomNightRangeHandler, getRoomNightRangeQuery } from './queries';
import {
  BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY, createBookingAvailabilityQuoteReservation,
  type BookingAvailabilityQuoteReservation,
} from './quote-reservation';
import { BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY } from './room-night-operations';
import type { BookingPropertyLockedQuoteFactsLookup, BookingPropertyLookup } from './types';

export const BOOKING_PROPERTY_READ_CAPABILITY = 'booking.property.read.v1';
export const BOOKING_AVAILABILITY_QUOTE_CAPABILITY = 'booking.availability.quote.v1';
export { BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY };

type BookingPropertyCapability = BookingPropertyLookup & BookingPropertyLockedQuoteFactsLookup;

export function bindBookingAvailabilityQuoteReservation(
  propertyBinding: BoundModuleCapability<BookingPropertyCapability>,
  quoteLimits: BookingQuoteLimits,
  quoteSigningKeyring: Keyring,
): BoundModuleCapability<BookingAvailabilityQuoteReservation> {
  return bindModuleCapability(
    'booking-availability',
    BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
    createBookingAvailabilityQuoteReservation(propertyBinding.value, quoteLimits, quoteSigningKeyring),
  );
}

export interface BookingAvailabilityRuntimeComposition {
  readonly module: PlatformModule;
  readonly quoteReservation: BoundModuleCapability<BookingAvailabilityQuoteReservation>;
}

type AvailabilityDelegates = {
  readonly quote: BookingAvailabilityQuoteCapability;
  readonly search: BookingAvailabilitySearchCapability;
  readonly quoteReservation: BookingAvailabilityQuoteReservation;
};

function createAvailabilityModule(
  propertyBinding: BoundModuleCapability<BookingPropertyCapability>,
  delegates: AvailabilityDelegates,
  bindRuntimeSecurity?: (security: RuntimeSecurity) => void,
): PlatformModule {
  const properties = propertyBinding.value;
  return defineModule({
    name: 'booking-availability', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [
      { name: 'platform', versionRange: '^0.1.0' },
      { name: 'booking-property', versionRange: '^0.1.0' },
    ] },
    capabilities: {
      provides: [
        BOOKING_AVAILABILITY_QUOTE_CAPABILITY,
        BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
        BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
      ],
      required: [{ from: 'booking-property', capability: BOOKING_PROPERTY_READ_CAPABILITY, versionRange: '^0.1.0' }],
      bound: [propertyBinding],
    },
    data: { owns: ['booking_availability_room_type_prices', 'booking_availability_room_nights'] },
    pages: bookingAvailabilityPages,
    migrations: bookingAvailabilityMigrations,
    permissions: [
      { key: 'booking-availability:read', description: 'Read Booking Availability', owner: 'booking-availability' },
      { key: 'booking-availability:quote', description: 'Get a current, non-persistent Booking Quote', owner: 'booking-availability' },
      { key: 'booking-availability:manage', description: 'Manage Booking Room Night supply and prices', owner: 'booking-availability' },
    ],
    commands: [
      { descriptor: setBaseNightlyPriceCommand, handler: createSetBaseNightlyPriceHandler(properties) },
      { descriptor: updateRoomNightRangeCommand, handler: createUpdateRoomNightRangeHandler(properties) },
    ],
    queries: [
      { descriptor: getRoomNightRangeQuery, handler: createGetRoomNightRangeHandler(properties) },
      { descriptor: getBookingQuoteQuery, handler: createGetBookingQuoteHandler(delegates.quote) },
      { descriptor: searchBookingQuotesQuery, handler: createSearchBookingQuotesHandler(delegates.search) },
    ],
    ...(bindRuntimeSecurity ? { bindRuntimeSecurity } : {}),
    ...(bindRuntimeSecurity ? { runtimeSecurity: { signingKeyPurposes: ['booking-quote'] } } : {}),
  });
}

/**
 * Builds the secret-free Availability contribution for a Release. The Kernel
 * supplies its already-resolved Keyring through this module's synchronous
 * runtime hook, before a database or handler is available. Quote, Search, and
 * Quote Reservation all delegate through the same once-bound closure.
 */
export function composeBookingAvailabilityRuntime(
  propertyBinding: BoundModuleCapability<BookingPropertyCapability>,
  quoteLimits: BookingQuoteLimits,
): BookingAvailabilityRuntimeComposition {
  const properties = propertyBinding.value;
  let state: 'unbound' | 'bound' | 'failed' = 'unbound';
  let bound: AvailabilityDelegates | undefined;
  const requireBound = (): AvailabilityDelegates => {
    if (!bound) throw new Error('Booking Availability Quote runtime security is not bound');
    return bound;
  };
  const delegates: AvailabilityDelegates = Object.freeze({
    quote: Object.freeze({
      quote: (...args: Parameters<BookingAvailabilityQuoteCapability['quote']>) => requireBound().quote.quote(...args),
    }),
    search: Object.freeze({
      search: (...args: Parameters<BookingAvailabilitySearchCapability['search']>) => requireBound().search.search(...args),
    }),
    quoteReservation: Object.freeze({
      revalidateAndReserve: (...args: Parameters<BookingAvailabilityQuoteReservation['revalidateAndReserve']>) =>
        requireBound().quoteReservation.revalidateAndReserve(...args),
    }),
  });
  const bindRuntimeSecurity = (security: RuntimeSecurity): void => {
    if (state !== 'unbound') throw new TypeError('Booking Availability Quote runtime security may only be bound once');
    state = 'failed';
    // Quote construction hard-codes the booking-quote purpose. This narrow seam
    // carries a Keyring only; it never exposes raw or purpose-derived bytes.
    const keyring = security.keyring;
    if (!keyring) throw new TypeError('Booking Availability Quote requires a configured signing Keyring');
    bound = Object.freeze({
      quote: createBookingAvailabilityQuote(properties, quoteLimits, keyring),
      search: createBookingAvailabilitySearch(properties, quoteLimits, keyring),
      quoteReservation: createBookingAvailabilityQuoteReservation(properties, quoteLimits, keyring),
    });
    state = 'bound';
  };
  return Object.freeze({
    module: createAvailabilityModule(propertyBinding, delegates, bindRuntimeSecurity),
    quoteReservation: bindModuleCapability(
      'booking-availability', BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY, delegates.quoteReservation,
    ),
  });
}

/** Existing in-process callers compose with an explicit Keyring; Releases use the runtime seam above. */
export function createBookingAvailabilityModule(
  propertyBinding: BoundModuleCapability<BookingPropertyCapability>,
  quoteLimits: BookingQuoteLimits,
  quoteSigningKeyring: Keyring,
): PlatformModule {
  const properties = propertyBinding.value;
  return createAvailabilityModule(propertyBinding, {
    quote: createBookingAvailabilityQuote(properties, quoteLimits, quoteSigningKeyring),
    search: createBookingAvailabilitySearch(properties, quoteLimits, quoteSigningKeyring),
    quoteReservation: createBookingAvailabilityQuoteReservation(properties, quoteLimits, quoteSigningKeyring),
  });
}
