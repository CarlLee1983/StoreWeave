import packageJson from '../package.json';
import { bindModuleCapability, type BoundModuleCapability, defineModule } from '@storeweave/kernel';
import type { Keyring } from '@storeweave/crypto';
import {
  createSetBaseNightlyPriceHandler, createUpdateRoomNightRangeHandler,
  setBaseNightlyPriceCommand, updateRoomNightRangeCommand,
} from './commands';
import { bookingAvailabilityMigrations } from './migrations';
import { createBookingAvailabilityQuote, createGetBookingQuoteHandler, getBookingQuoteQuery, type BookingQuoteLimits } from './quote';
import { createBookingAvailabilitySearch, createSearchBookingQuotesHandler, searchBookingQuotesQuery } from './search';
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

export function createBookingAvailabilityModule(
  propertyBinding: BoundModuleCapability<BookingPropertyCapability>,
  quoteLimits: BookingQuoteLimits,
  quoteSigningKeyring: Keyring,
) {
  const properties = propertyBinding.value;
  const quote = createBookingAvailabilityQuote(properties, quoteLimits, quoteSigningKeyring);
  const search = createBookingAvailabilitySearch(properties, quoteLimits, quoteSigningKeyring);
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
      { descriptor: getBookingQuoteQuery, handler: createGetBookingQuoteHandler(quote) },
      { descriptor: searchBookingQuotesQuery, handler: createSearchBookingQuotesHandler(search) },
    ],
  });
}
