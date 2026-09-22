import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@storeweave/contracts';
import { BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES } from './types';
import {
  bookingReservationPaymentAttempts,
  bookingReservationReservations,
  type BookingReservationPaymentAttemptRow,
  type BookingReservationRow,
} from './schema';

export class BookingReservationRepository {
  async databaseNow(tx: Tx): Promise<Date> {
    const result = await tx.execute<{ now_ms: unknown }>(sql`
      SELECT (extract(epoch FROM now()) * 1000)::float8 AS now_ms
    `);
    const now = new Date(Number(result.rows[0]?.now_ms));
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Database returned an invalid transaction timestamp');
    }
    return now;
  }

  async insert(tx: Tx, values: typeof bookingReservationReservations.$inferInsert): Promise<BookingReservationRow> {
    const [row] = await tx.insert(bookingReservationReservations).values(values).returning();
    return row!;
  }

  async lockById(tx: Tx, id: string): Promise<BookingReservationRow | undefined> {
    const [row] = await tx.select().from(bookingReservationReservations)
      .where(eq(bookingReservationReservations.id, id))
      .for('update');
    return row;
  }

  async insertPaymentAttempt(
    tx: Tx,
    values: typeof bookingReservationPaymentAttempts.$inferInsert,
  ): Promise<BookingReservationPaymentAttemptRow> {
    const [row] = await tx.insert(bookingReservationPaymentAttempts).values(values).returning();
    return row!;
  }

  async lockPaymentAttemptById(tx: Tx, id: string): Promise<BookingReservationPaymentAttemptRow | undefined> {
    const [row] = await tx.select().from(bookingReservationPaymentAttempts)
      .where(eq(bookingReservationPaymentAttempts.id, id))
      .for('update');
    return row;
  }

  async findPaymentAttemptById(tx: Tx, id: string): Promise<BookingReservationPaymentAttemptRow | undefined> {
    const [row] = await tx.select().from(bookingReservationPaymentAttempts)
      .where(eq(bookingReservationPaymentAttempts.id, id));
    return row;
  }

  async findPaymentAttemptByReference(tx: Tx, reference: string): Promise<BookingReservationPaymentAttemptRow | undefined> {
    const [row] = await tx.select().from(bookingReservationPaymentAttempts)
      .where(eq(bookingReservationPaymentAttempts.reference, reference));
    return row;
  }

  async lockPaymentAttemptsForReservation(tx: Tx, reservationId: string): Promise<BookingReservationPaymentAttemptRow[]> {
    return tx.select().from(bookingReservationPaymentAttempts)
      .where(eq(bookingReservationPaymentAttempts.reservationId, reservationId))
      .orderBy(asc(bookingReservationPaymentAttempts.createdAt), asc(bookingReservationPaymentAttempts.id))
      .for('update');
  }

  async findActivePaymentAttempt(
    tx: Tx,
    reservationId: string,
  ): Promise<BookingReservationPaymentAttemptRow | undefined> {
    const [row] = await tx.select().from(bookingReservationPaymentAttempts)
      .where(and(
        eq(bookingReservationPaymentAttempts.reservationId, reservationId),
        inArray(bookingReservationPaymentAttempts.status, [...BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
      ))
      .for('update');
    return row;
  }

  async updatePaymentAttempt(
    tx: Tx,
    attemptId: string,
    values: Partial<Pick<typeof bookingReservationPaymentAttempts.$inferInsert,
      'status' | 'providerRef' | 'action' | 'instructions' | 'expiresAt' | 'failureReason' | 'failureMessage' | 'successKind' | 'succeededAt'>>,
    now: Date,
  ): Promise<BookingReservationPaymentAttemptRow | undefined> {
    const [row] = await tx.update(bookingReservationPaymentAttempts)
      .set({ ...values, updatedAt: now })
      .where(eq(bookingReservationPaymentAttempts.id, attemptId))
      .returning();
    return row;
  }

  async confirmWithWinningAttempt(tx: Tx, reservationId: string, attemptId: string): Promise<void> {
    await tx.update(bookingReservationReservations).set({ status: 'confirmed', winningPaymentAttemptId: attemptId })
      .where(eq(bookingReservationReservations.id, reservationId));
  }

  async extendPaymentDeadline(tx: Tx, reservationId: string, paymentExpiresAt: Date): Promise<void> {
    await tx.update(bookingReservationReservations).set({ paymentExpiresAt })
      .where(eq(bookingReservationReservations.id, reservationId));
  }

  async expireActivePaymentAttempts(
    tx: Tx,
    reservationId: string,
    now: Date,
  ): Promise<BookingReservationPaymentAttemptRow[]> {
    await tx.select({ id: bookingReservationPaymentAttempts.id }).from(bookingReservationPaymentAttempts)
      .where(and(
        eq(bookingReservationPaymentAttempts.reservationId, reservationId),
        inArray(bookingReservationPaymentAttempts.status, [...BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
      ))
      .orderBy(asc(bookingReservationPaymentAttempts.createdAt), asc(bookingReservationPaymentAttempts.id))
      .for('update');
    return tx.update(bookingReservationPaymentAttempts)
      .set({ status: 'expired', updatedAt: now })
      .where(and(
        eq(bookingReservationPaymentAttempts.reservationId, reservationId),
        inArray(bookingReservationPaymentAttempts.status, [...BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES]),
      ))
      .returning();
  }

  async claimAccount(tx: Tx, reservationId: string, accountId: string): Promise<'claimed' | 'already-owner' | 'not-found' | 'owned-by-another' | 'anonymized'> {
    const [claimed] = await tx.update(bookingReservationReservations).set({ ownerAccountId: accountId })
      .where(and(
        eq(bookingReservationReservations.id, reservationId),
        isNull(bookingReservationReservations.ownerAccountId),
        isNull(bookingReservationReservations.piiAnonymizedAt),
      )).returning({ id: bookingReservationReservations.id });
    if (claimed) return 'claimed';

    const [current] = await tx.select({
      ownerAccountId: bookingReservationReservations.ownerAccountId,
      piiAnonymizedAt: bookingReservationReservations.piiAnonymizedAt,
    })
      .from(bookingReservationReservations)
      .where(eq(bookingReservationReservations.id, reservationId))
      .for('update');
    if (!current) return 'not-found';
    if (current.piiAnonymizedAt !== null) return 'anonymized';
    return current.ownerAccountId === accountId ? 'already-owner' : 'owned-by-another';
  }

  async findOwnedById(tx: Tx, reservationId: string, accountId: string): Promise<BookingReservationRow | undefined> {
    const [row] = await tx.select().from(bookingReservationReservations).where(and(
      eq(bookingReservationReservations.id, reservationId),
      eq(bookingReservationReservations.ownerAccountId, accountId),
    ));
    return row;
  }

  async findById(tx: Tx, reservationId: string): Promise<BookingReservationRow | undefined> {
    const [row] = await tx.select().from(bookingReservationReservations)
      .where(eq(bookingReservationReservations.id, reservationId));
    return row;
  }

  async updateOwnedDetails(tx: Tx, reservationId: string, accountId: string, values: ManagedReservationDetails): Promise<boolean> {
    const [row] = await tx.update(bookingReservationReservations).set(values).where(and(
      eq(bookingReservationReservations.id, reservationId),
      eq(bookingReservationReservations.ownerAccountId, accountId),
      isNull(bookingReservationReservations.piiAnonymizedAt),
    )).returning({ id: bookingReservationReservations.id });
    return row !== undefined;
  }

  async updateManagedDetails(tx: Tx, reservationId: string, values: ManagedReservationDetails): Promise<boolean> {
    const [row] = await tx.update(bookingReservationReservations).set(values)
      .where(and(
        eq(bookingReservationReservations.id, reservationId),
        isNull(bookingReservationReservations.piiAnonymizedAt),
      ))
      .returning({ id: bookingReservationReservations.id });
    return row !== undefined;
  }

  async databaseClock(tx: Tx): Promise<Date> {
    const result = await tx.execute<{ now_ms: unknown }>(sql`
      SELECT (extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::float8 AS now_ms
    `);
    const now = new Date(Number(result.rows[0]?.now_ms));
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Database returned an invalid clock timestamp');
    }
    return now;
  }

  async lockAccessState(tx: Tx, id: string) {
    const [row] = await tx.select({
      id: bookingReservationReservations.id,
      accessGeneration: bookingReservationReservations.accessGeneration,
      accessGrantNonce: bookingReservationReservations.accessGrantNonce,
      accessGrantExpiresAt: bookingReservationReservations.accessGrantExpiresAt,
      accessGrantUsedAt: bookingReservationReservations.accessGrantUsedAt,
      managementTokenHash: bookingReservationReservations.managementTokenHash,
      piiAnonymizedAt: bookingReservationReservations.piiAnonymizedAt,
    }).from(bookingReservationReservations)
      .where(eq(bookingReservationReservations.id, id))
      .for('update');
    return row;
  }

  async lockRetentionBatch(tx: Tx, afterId: string | null, limit: number): Promise<BookingReservationRow[]> {
    const conditions = [
      isNull(bookingReservationReservations.piiAnonymizedAt),
    ];
    if (afterId !== null) conditions.push(gt(bookingReservationReservations.id, afterId));
    return tx.select().from(bookingReservationReservations)
      .where(and(...conditions))
      .orderBy(asc(bookingReservationReservations.id))
      .limit(limit)
      .for('update');
  }

  async anonymizeReservationPii(tx: Tx, reservationId: string, anonymizedAt: Date): Promise<boolean> {
    const [row] = await tx.update(bookingReservationReservations).set({
      bookerName: null,
      bookerEmail: null,
      bookerPhone: null,
      primaryGuestName: null,
      accommodationNotes: null,
      accessGeneration: 0,
      ownerAccountId: null,
      accessGrantNonce: null,
      accessGrantExpiresAt: null,
      accessGrantUsedAt: null,
      managementTokenHash: null,
      piiAnonymizedAt: anonymizedAt,
    }).where(and(
      eq(bookingReservationReservations.id, reservationId),
      isNull(bookingReservationReservations.piiAnonymizedAt),
    )).returning({ id: bookingReservationReservations.id });
    return row !== undefined;
  }

  async rotateAccessGrant(tx: Tx, input: {
    reservationId: string;
    generation: number;
    nonce: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const [updated] = await tx.update(bookingReservationReservations).set({
      accessGeneration: input.generation,
      accessGrantNonce: input.nonce,
      accessGrantExpiresAt: input.expiresAt,
      accessGrantUsedAt: null,
      managementTokenHash: null,
    }).where(eq(bookingReservationReservations.id, input.reservationId))
      .returning({ id: bookingReservationReservations.id });
    return updated !== undefined;
  }

  async consumeAccessGrant(tx: Tx, input: {
    reservationId: string;
    generation: number;
    nonce: string;
    expiresAt: Date;
    tokenHash: string;
  }): Promise<boolean> {
    const [updated] = await tx.update(bookingReservationReservations).set({
      accessGrantUsedAt: sql`pg_catalog.clock_timestamp()`,
      managementTokenHash: input.tokenHash,
    }).where(and(
      eq(bookingReservationReservations.id, input.reservationId),
      eq(bookingReservationReservations.accessGeneration, input.generation),
      eq(bookingReservationReservations.accessGrantNonce, input.nonce),
      eq(bookingReservationReservations.accessGrantExpiresAt, input.expiresAt),
      sql`${bookingReservationReservations.accessGrantExpiresAt} > pg_catalog.clock_timestamp()`,
      sql`${bookingReservationReservations.accessGrantUsedAt} IS NULL`,
      sql`${bookingReservationReservations.managementTokenHash} IS NULL`,
    )).returning({ id: bookingReservationReservations.id });
    return updated !== undefined;
  }

  async expireIfCurrent(tx: Tx, reservation: BookingReservationRow, expectedPaymentExpiresAt: Date): Promise<boolean> {
    const [updated] = await tx.update(bookingReservationReservations)
      .set({ status: 'expired' })
      .where(and(
        eq(bookingReservationReservations.id, reservation.id),
        eq(bookingReservationReservations.status, 'pending_payment'),
        eq(bookingReservationReservations.paymentExpiresAt, expectedPaymentExpiresAt),
      ))
      .returning({ id: bookingReservationReservations.id });
    return updated !== undefined;
  }
}

export type ManagedReservationDetails = Partial<Pick<
  typeof bookingReservationReservations.$inferInsert,
  'bookerName' | 'bookerEmail' | 'bookerPhone' | 'primaryGuestName' | 'accommodationNotes'
>>;
