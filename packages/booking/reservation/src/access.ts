import { randomUUID } from 'node:crypto';
import { PlatformError, type Tx } from '@storeweave/contracts';
import { constantTimeEquals, randomToken, sha256Hex, signValue, verifySignedValue, type Keyring } from '@storeweave/crypto';
import { z } from 'zod';
import { BookingReservationRepository } from './repository';

export const BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE = 'booking-reservation-access-grant';
export const BOOKING_RESERVATION_ACCESS_CAPABILITY = 'booking.reservation.access.v1';

const MIN_ACCESS_GRANT_TTL_MS = 60_000;
const MAX_ACCESS_GRANT_TTL_MS = 60 * 60_000;
const MAX_GENERATION = 2_147_483_647;
const MANAGEMENT_CREDENTIAL_VERSION = 'brm1';

const issueGrantInputSchema = z.object({
  reservationId: z.string().uuid(),
  ttlMs: z.number().int().min(MIN_ACCESS_GRANT_TTL_MS).max(MAX_ACCESS_GRANT_TTL_MS),
}).strict();

const grantClaimsSchema = z.object({
  version: z.literal(1),
  reservationId: z.string().uuid(),
  generation: z.number().int().min(1).max(MAX_GENERATION),
  nonce: z.string().uuid(),
}).strict();

const redeemGrantInputSchema = z.object({ grantToken: z.string().min(1).max(4096) }).strict();
const authorizeManagementInputSchema = z.object({
  reservationId: z.string().uuid(),
  managementCredential: z.string().min(1).max(128),
}).strict();

export interface IssuedBookingReservationGrant {
  readonly grantToken: string;
  readonly expiresAt: Date;
  readonly generation: number;
}

export interface RedeemedBookingReservationGrant {
  /** Returned once to the caller so an HTTP adapter can set its secure cookie. */
  readonly managementCredential: string;
}

export interface BookingReservationAccess {
  issueGrant(tx: Tx, input: { reservationId: string; ttlMs: number }): Promise<IssuedBookingReservationGrant>;
  redeemGrant(tx: Tx, input: { grantToken: string }): Promise<RedeemedBookingReservationGrant>;
  /** Authorizes only the addressed Reservation and returns no Reservation data. */
  authorizeManagement(tx: Tx, input: { reservationId: string; managementCredential: string }): Promise<{ reservationId: string }>;
}

function invalidAccess(): PlatformError {
  return new PlatformError('UNAUTHENTICATED', 'Reservation access is invalid or has expired');
}

function canonicalManagementGeneration(credential: string): number | undefined {
  const [version, generationRaw, secret, extra] = credential.split('.');
  if (version !== MANAGEMENT_CREDENTIAL_VERSION || extra !== undefined
    || !/^[1-9]\d*$/.test(generationRaw ?? '')) return undefined;
  const generation = Number(generationRaw);
  if (!Number.isSafeInteger(generation) || generation > MAX_GENERATION) return undefined;
  if (!secret || Buffer.from(secret, 'base64url').toString('base64url') !== secret
    || Buffer.from(secret, 'base64url').length !== 32) return undefined;
  return generation;
}

function claimsFromPayload(payload: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = grantClaimsSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Reservation access is pre-Actor authentication state. Call it directly from a
 * trusted adapter or command handler inside that operation's transaction; never
 * put redemption behind CommandBus because its idempotency response is durable.
 */
export function createBookingReservationAccess(
  keyring: Keyring,
  repository = new BookingReservationRepository(),
): BookingReservationAccess {
  return Object.freeze({
    async issueGrant(tx: Tx, rawInput: unknown) {
      const parsed = issueGrantInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw PlatformError.validation('Invalid Reservation Access Grant issuance input', parsed.error.issues);
      }
      const { reservationId, ttlMs } = parsed.data;
      const current = await repository.lockAccessState(tx, reservationId);
      if (!current) throw PlatformError.notFound('Reservation', reservationId);
      if (current.piiAnonymizedAt !== null) throw invalidAccess();
      if (current.accessGeneration >= MAX_GENERATION) {
        throw PlatformError.conflict('Reservation access generation is exhausted');
      }

      const databaseNow = await repository.databaseClock(tx);
      // Round up so the actual lifetime cannot fall below the requested minimum,
      // then cap at a whole-second instant that stays within the one-hour maximum.
      const requestedExpiry = Math.ceil((databaseNow.getTime() + ttlMs) / 1000) * 1000;
      const maximumExpiry = Math.floor((databaseNow.getTime() + MAX_ACCESS_GRANT_TTL_MS) / 1000) * 1000;
      const expiresAt = new Date(Math.min(requestedExpiry, maximumExpiry));
      if (expiresAt.getTime() - databaseNow.getTime() < MIN_ACCESS_GRANT_TTL_MS) {
        throw PlatformError.validation('Reservation Access Grant expiry must be in the future');
      }

      const generation = current.accessGeneration + 1;
      const nonce = randomUUID();
      const grantToken = signValue(keyring, {
        purpose: BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
        payload: JSON.stringify({ version: 1, reservationId, generation, nonce }),
        expiresAt,
      });
      const updated = await repository.rotateAccessGrant(tx, { reservationId, generation, nonce, expiresAt });
      if (!updated) throw PlatformError.conflict('Reservation changed while issuing its Access Grant');
      return { grantToken, expiresAt, generation };
    },

    async redeemGrant(tx: Tx, rawInput: unknown) {
      const parsed = redeemGrantInputSchema.safeParse(rawInput);
      if (!parsed.success) throw invalidAccess();

      const databaseNow = await repository.databaseClock(tx);
      const verified = verifySignedValue(keyring, {
        purpose: BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE,
        token: parsed.data.grantToken,
        now: databaseNow,
      });
      if (!verified.ok) throw invalidAccess();

      const claims = claimsFromPayload(verified.payload);
      if (!claims) throw invalidAccess();

      const current = await repository.lockAccessState(tx, claims.reservationId);
      if (!current
        || current.piiAnonymizedAt !== null
        || current.accessGeneration !== claims.generation
        || current.accessGrantNonce !== claims.nonce
        || current.accessGrantExpiresAt?.getTime() !== verified.expiresAt.getTime()
        || current.accessGrantUsedAt !== null
        || current.managementTokenHash !== null) {
        throw invalidAccess();
      }

      const managementCredential = `${MANAGEMENT_CREDENTIAL_VERSION}.${claims.generation}.${randomToken(32)}`;
      const consumed = await repository.consumeAccessGrant(tx, {
        reservationId: claims.reservationId,
        generation: claims.generation,
        nonce: claims.nonce,
        expiresAt: verified.expiresAt,
        tokenHash: sha256Hex(managementCredential),
      });
      if (!consumed) throw invalidAccess();
      return { managementCredential };
    },

    async authorizeManagement(tx: Tx, rawInput: unknown) {
      const parsed = authorizeManagementInputSchema.safeParse(rawInput);
      if (!parsed.success) throw invalidAccess();
      const { reservationId, managementCredential } = parsed.data;
      const generation = canonicalManagementGeneration(managementCredential);
      if (generation === undefined) throw invalidAccess();

      const current = await repository.lockAccessState(tx, reservationId);
      if (!current || current.piiAnonymizedAt !== null
        || current.accessGeneration !== generation || current.managementTokenHash === null
        || current.accessGrantUsedAt === null
        || !constantTimeEquals(current.managementTokenHash, sha256Hex(managementCredential))) {
        throw invalidAccess();
      }
      return { reservationId };
    },
  });
}
