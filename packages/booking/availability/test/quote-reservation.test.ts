import { createKeyring } from '@storeweave/crypto';
import { describe, expect, it } from 'vitest';
import { createBookingAvailabilityQuoteReservation } from '../src/quote-reservation';
import type { BookingPropertyLockedQuoteFactsLookup } from '../src/types';

const keyring = createKeyring({
  activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 9).toString('base64url') }],
});

const properties: BookingPropertyLockedQuoteFactsLookup = {
  async requireLockedQuoteFacts() {
    throw new Error('Quote reservation factory tests must not perform Property reads');
  },
};

const repository = {
  async lockBasePrice() { return null; },
  async materializeRoomNightsInDateOrder() {},
  async lockRoomNights() { return []; },
  async adjustReservedUnits() { return 0; },
};

describe('Booking Availability Quote reservation contract', () => {
  it('requires a valid explicit request room-count cap', () => {
    expect(() => createBookingAvailabilityQuoteReservation(
      properties, { maxRoomsPerRequest: 0 }, keyring, repository,
    )).toThrow(/Invalid Booking Quote reservation limits/);

    expect(() => createBookingAvailabilityQuoteReservation(
      properties, { maxRoomsPerRequest: 4 }, keyring, repository,
    )).not.toThrow();
  });
});
