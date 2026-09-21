import { describe, expect, it } from 'vitest';
import { createBookingReservationInputSchema } from '../src/types';

const validInput = {
  quote: {
    roomTypeId: '123e4567-e89b-12d3-a456-426614174000',
    checkInLocalDate: '2030-05-01', checkOutLocalDate: '2030-05-03',
    adults: 2, children: 0, roomCount: 1,
    fingerprint: `booking-quote-v1:test:${'a'.repeat(64)}`,
  },
  booker: { name: '  Booker  ', email: ' booker@example.test ', phone: ' +1 (555) 0100 ' },
  primaryGuestName: ' Guest ',
  accommodationNotes: '  Late arrival  ',
};

describe('Booking Reservation input', () => {
  it('validates and trims the minimal Booker and Guest snapshot', () => {
    expect(createBookingReservationInputSchema.parse(validInput)).toMatchObject({
      booker: { name: 'Booker', email: 'booker@example.test', phone: '+1 (555) 0100' },
      primaryGuestName: 'Guest', accommodationNotes: 'Late arrival',
    });
  });

  it('rejects malformed contact fields and unexpected guest identity data', () => {
    expect(createBookingReservationInputSchema.safeParse({
      ...validInput, booker: { ...validInput.booker, email: 'not-an-email' },
    }).success).toBe(false);
    expect(createBookingReservationInputSchema.safeParse({
      ...validInput, passportNumber: 'must-not-be-collected',
    }).success).toBe(false);
    expect(createBookingReservationInputSchema.safeParse({
      ...validInput, booker: { ...validInput.booker, fullGuestList: ['another person'] },
    }).success).toBe(false);
  });
});
