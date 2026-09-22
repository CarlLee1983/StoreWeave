import { createKeyring, sha256Hex } from '@storeweave/crypto';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE,
  createBookingReservationCheckoutAccess,
} from '../src/checkout-access';

const keyring = createKeyring({
  activeKeyId: 'test',
  keys: [{ id: 'test', secret: Buffer.alloc(32, 7).toString('base64url') }],
});

describe('Booking Reservation checkout access', () => {
  it('derives only hashable state from the active key and payment expiry', () => {
    const access = createBookingReservationCheckoutAccess(keyring);
    const reservationId = '123e4567-e89b-12d3-a456-426614174000';
    const expiresAt = new Date('2031-01-02T03:04:05.000Z');
    const prepared = access.prepare(reservationId, expiresAt);

    expect(prepared).toMatchObject({
      keyId: 'test', nonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), expiresAt,
    });
    // HMAC material is purpose-separated from all existing Booking credentials.
    expect(keyring.derive(BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE, 'test'))
      .not.toEqual(keyring.derive('booking-reservation-access-grant', 'test'));
    expect(prepared.tokenHash).not.toEqual(sha256Hex(reservationId));
  });

  it('changes the persisted verifier when either expiry or nonce changes', () => {
    const access = createBookingReservationCheckoutAccess(keyring);
    const reservationId = '123e4567-e89b-12d3-a456-426614174000';
    const first = access.prepare(reservationId, new Date('2031-01-02T03:04:05.000Z'));
    const second = access.prepare(reservationId, new Date('2031-01-02T03:04:05.000Z'));
    const later = access.prepare(reservationId, new Date('2031-01-02T03:04:06.000Z'));

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.tokenHash).not.toBe(first.tokenHash);
    expect(later.tokenHash).not.toBe(first.tokenHash);
  });
});
