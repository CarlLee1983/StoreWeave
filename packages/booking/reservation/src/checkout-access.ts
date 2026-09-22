import { randomUUID } from 'node:crypto';
import { PlatformError, type Tx } from '@storeweave/contracts';
import { constantTimeEquals, hmacSha256, sha256Hex, type Keyring } from '@storeweave/crypto';
import { BookingReservationRepository } from './repository';
import type { BookingReservationRow } from './schema';

export const BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE = 'booking-reservation-checkout-credential';
const CHECKOUT_CREDENTIAL_VERSION = 'brc1';

export interface PreparedBookingReservationCheckoutCredential {
  readonly keyId: string;
  readonly nonce: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface BookingReservationCheckoutAccess {
  /** Produces only hashable state for Reservation creation; never return its bearer from CommandBus. */
  prepare(reservationId: string, expiresAt: Date): PreparedBookingReservationCheckoutCredential;
  /** Trusted adapters call this after create/replay, outside the durable CommandBus response. */
  present(tx: Tx, reservationId: string): Promise<{ credential: string; expiresAt: Date }>;
  /** Locks and authenticates the addressed pending Reservation in the payment transaction. */
  authorizePayment(tx: Tx, reservationId: string, credential: unknown): Promise<BookingReservationRow>;
}

function invalidCheckoutAccess(): PlatformError {
  return new PlatformError('UNAUTHENTICATED', 'Reservation checkout access is invalid or has expired');
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function canonical(reservationId: string, nonce: string, expiresAt: Date): string {
  return [CHECKOUT_CREDENTIAL_VERSION, reservationId, nonce, String(expiresAt.getTime())].join('\n');
}

function credentialFor(keyring: Keyring, state: {
  keyId: string; reservationId: string; nonce: string; expiresAt: Date;
}): string {
  const key = keyring.derive(BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE, state.keyId);
  try {
    const digest = hmacSha256(key, canonical(state.reservationId, state.nonce, state.expiresAt));
    try {
      return `${CHECKOUT_CREDENTIAL_VERSION}.${digest.toString('base64url')}`;
    } finally {
      digest.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export function createBookingReservationCheckoutAccess(
  keyring: Keyring,
  repository = new BookingReservationRepository(),
): BookingReservationCheckoutAccess {
  return Object.freeze({
    prepare(reservationId: string, expiresAt: Date) {
      if (!validDate(expiresAt)) throw new TypeError('Checkout credential requires a valid expiry');
      const keyId = keyring.activeKeyId;
      const nonce = randomUUID();
      const credential = credentialFor(keyring, { keyId, reservationId, nonce, expiresAt });
      return { keyId, nonce, tokenHash: sha256Hex(credential), expiresAt };
    },

    async present(tx: Tx, reservationId: string) {
      const current = await repository.lockCheckoutAccessState(tx, reservationId);
      if (!current || current.checkoutCredentialKeyId === null || current.checkoutCredentialNonce === null
        || current.checkoutCredentialHash === null || current.checkoutCredentialExpiresAt === null
        || current.checkoutCredentialRevokedAt !== null) throw invalidCheckoutAccess();
      const now = await repository.databaseClock(tx);
      if (current.status !== 'pending_payment' || current.piiAnonymizedAt !== null
        || current.checkoutCredentialExpiresAt.getTime() <= now.getTime()) throw invalidCheckoutAccess();
      const credential = credentialFor(keyring, {
        keyId: current.checkoutCredentialKeyId, reservationId: current.id,
        nonce: current.checkoutCredentialNonce, expiresAt: current.checkoutCredentialExpiresAt,
      });
      if (!constantTimeEquals(current.checkoutCredentialHash, sha256Hex(credential))) throw invalidCheckoutAccess();
      return { credential, expiresAt: current.checkoutCredentialExpiresAt };
    },

    async authorizePayment(tx: Tx, reservationId: string, credential: unknown) {
      const current = await repository.lockById(tx, reservationId);
      // Hash even malformed input before comparing. This makes the accepted raw
      // bearer an implementation detail, not a parser oracle.
      const suppliedHash = sha256Hex(typeof credential === 'string' ? credential : '');
      if (!current || current.checkoutCredentialHash === null || current.checkoutCredentialRevokedAt !== null
        || !constantTimeEquals(current.checkoutCredentialHash, suppliedHash)) throw invalidCheckoutAccess();
      const now = await repository.databaseClock(tx);
      if (current.status !== 'pending_payment' || current.piiAnonymizedAt !== null
        || current.checkoutCredentialExpiresAt === null
        || current.checkoutCredentialExpiresAt.getTime() <= now.getTime()) throw invalidCheckoutAccess();
      return current;
    },
  });
}
