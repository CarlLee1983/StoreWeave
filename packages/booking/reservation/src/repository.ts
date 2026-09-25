import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { BOOKING_RESERVATION_ACTIVE_PAYMENT_ATTEMPT_STATUSES } from './types';
import {
  bookingReservationPaymentAttempts,
  bookingReservationNotificationLinks,
  bookingReservationRefundInvocations,
  bookingReservationRefunds,
  bookingReservationReservations,
  type BookingReservationRefundInvocationRow,
  type BookingReservationRefundRow,
  type BookingReservationPaymentAttemptRow,
  type BookingReservationNotificationLinkRow,
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

  /** Wall-clock time is intentionally distinct from PostgreSQL transaction time. */
  async databaseWallClock(tx: Tx): Promise<Date> {
    const result = await tx.execute<{ now_ms: unknown }>(sql`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms
    `);
    const now = new Date(Number(result.rows[0]?.now_ms));
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Database returned an invalid wall-clock timestamp');
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

  async listOperatorPaymentAttempts(
    db: DrizzleDb | Tx,
    input: { reservationId: string; limit: number; offset: number },
  ): Promise<{ items: BookingReservationPaymentAttemptRow[]; total: number }> {
    const where = eq(bookingReservationPaymentAttempts.reservationId, input.reservationId);
    const items = await db.select().from(bookingReservationPaymentAttempts).where(where)
      .orderBy(desc(bookingReservationPaymentAttempts.createdAt), desc(bookingReservationPaymentAttempts.id))
      .limit(input.limit).offset(input.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(bookingReservationPaymentAttempts).where(where);
    return { items, total: Number(count) };
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
    await tx.update(bookingReservationReservations).set({ status: 'confirmed', winningPaymentAttemptId: attemptId, checkoutCredentialRevokedAt: sql`pg_catalog.clock_timestamp()` })
      .where(eq(bookingReservationReservations.id, reservationId));
  }

  async extendPaymentDeadline(tx: Tx, reservationId: string, paymentExpiresAt: Date): Promise<void> {
    await tx.update(bookingReservationReservations).set({ paymentExpiresAt })
      .where(eq(bookingReservationReservations.id, reservationId));
  }

  async cancelIfCurrent(tx: Tx, reservationId: string): Promise<boolean> {
    const [row] = await tx.update(bookingReservationReservations).set({ status: 'cancelled', checkoutCredentialRevokedAt: sql`pg_catalog.clock_timestamp()` })
      .where(and(
        eq(bookingReservationReservations.id, reservationId),
        inArray(bookingReservationReservations.status, ['pending_payment', 'confirmed']),
      )).returning({ id: bookingReservationReservations.id });
    return row !== undefined;
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

  async listOperatorReservations(
    db: DrizzleDb | Tx,
    input: {
      limit: number; offset: number; status?: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled';
      roomTypeId?: string; checkInFrom?: string; checkInTo?: string;
    },
  ) {
    const where = and(
      input.status === undefined ? undefined : eq(bookingReservationReservations.status, input.status),
      input.roomTypeId === undefined ? undefined : eq(bookingReservationReservations.roomTypeId, input.roomTypeId),
      input.checkInFrom === undefined ? undefined : gte(bookingReservationReservations.checkInLocalDate, input.checkInFrom),
      input.checkInTo === undefined ? undefined : lte(bookingReservationReservations.checkInLocalDate, input.checkInTo),
    );
    const items = await db.select({
      id: bookingReservationReservations.id,
      status: bookingReservationReservations.status,
      roomTypeId: bookingReservationReservations.roomTypeId,
      checkInLocalDate: bookingReservationReservations.checkInLocalDate,
      checkOutLocalDate: bookingReservationReservations.checkOutLocalDate,
      roomCount: bookingReservationReservations.roomCount,
      adults: bookingReservationReservations.adults,
      children: bookingReservationReservations.children,
      currency: bookingReservationReservations.currency,
      totalMinor: bookingReservationReservations.totalMinor,
      paymentExpiresAt: bookingReservationReservations.paymentExpiresAt,
      createdAt: bookingReservationReservations.createdAt,
    }).from(bookingReservationReservations).where(where)
      .orderBy(desc(bookingReservationReservations.createdAt), desc(bookingReservationReservations.id))
      .limit(input.limit).offset(input.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(bookingReservationReservations).where(where);
    return { items, total: Number(count) };
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

  async lockCheckoutAccessState(tx: Tx, id: string) {
    const [row] = await tx.select({
      id: bookingReservationReservations.id, status: bookingReservationReservations.status,
      piiAnonymizedAt: bookingReservationReservations.piiAnonymizedAt,
      checkoutCredentialKeyId: bookingReservationReservations.checkoutCredentialKeyId,
      checkoutCredentialNonce: bookingReservationReservations.checkoutCredentialNonce,
      checkoutCredentialHash: bookingReservationReservations.checkoutCredentialHash,
      checkoutCredentialExpiresAt: bookingReservationReservations.checkoutCredentialExpiresAt,
      checkoutCredentialRevokedAt: bookingReservationReservations.checkoutCredentialRevokedAt,
    }).from(bookingReservationReservations).where(eq(bookingReservationReservations.id, id)).for('update');
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
      checkoutCredentialKeyId: null,
      checkoutCredentialNonce: null,
      checkoutCredentialHash: null,
      checkoutCredentialExpiresAt: null,
      checkoutCredentialRevokedAt: sql`pg_catalog.clock_timestamp()`,
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
      .set({ status: 'expired', checkoutCredentialRevokedAt: sql`pg_catalog.clock_timestamp()` })
      .where(and(
        eq(bookingReservationReservations.id, reservation.id),
        eq(bookingReservationReservations.status, 'pending_payment'),
        eq(bookingReservationReservations.paymentExpiresAt, expectedPaymentExpiresAt),
      ))
      .returning({ id: bookingReservationReservations.id });
    return updated !== undefined;
  }

  async findRefundByAttempt(tx: Tx, paymentAttemptId: string): Promise<BookingReservationRefundRow | undefined> {
    const [row] = await tx.select().from(bookingReservationRefunds)
      .where(eq(bookingReservationRefunds.paymentAttemptId, paymentAttemptId));
    return row;
  }

  async findRefundById(tx: Tx, refundId: string): Promise<BookingReservationRefundRow | undefined> {
    const [row] = await tx.select().from(bookingReservationRefunds).where(eq(bookingReservationRefunds.id, refundId));
    return row;
  }

  async lockRefundById(tx: Tx, refundId: string): Promise<BookingReservationRefundRow | undefined> {
    const [row] = await tx.select().from(bookingReservationRefunds).where(eq(bookingReservationRefunds.id, refundId)).for('update');
    return row;
  }

  async insertRefund(tx: Tx, values: typeof bookingReservationRefunds.$inferInsert): Promise<BookingReservationRefundRow> {
    const [row] = await tx.insert(bookingReservationRefunds).values(values).returning();
    return row!;
  }

  async updateRefund(tx: Tx, refundId: string, values: Partial<typeof bookingReservationRefunds.$inferInsert>, now: Date): Promise<BookingReservationRefundRow | undefined> {
    const [row] = await tx.update(bookingReservationRefunds).set({ ...values, updatedAt: now })
      .where(eq(bookingReservationRefunds.id, refundId)).returning();
    return row;
  }

  async listRefunds(
    db: DrizzleDb | Tx,
    input: { reservationId: string; limit: number; offset: number },
  ): Promise<{ items: BookingReservationRefundRow[]; total: number }> {
    const where = eq(bookingReservationRefunds.reservationId, input.reservationId);
    const items = await db.select().from(bookingReservationRefunds).where(where)
      .orderBy(desc(bookingReservationRefunds.requestedAt), desc(bookingReservationRefunds.id))
      .limit(input.limit).offset(input.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(bookingReservationRefunds).where(where);
    return { items, total: Number(count) };
  }

  async listPendingRefunds(tx: Tx): Promise<BookingReservationRefundRow[]> {
    return tx.select().from(bookingReservationRefunds).where(eq(bookingReservationRefunds.status, 'pending'))
      .orderBy(asc(bookingReservationRefunds.requestedAt), asc(bookingReservationRefunds.id)).limit(100);
  }

  async findNotificationLinkByEventTemplate(
    tx: Tx,
    eventId: string,
    templateId: BookingReservationNotificationLinkRow['templateId'],
  ): Promise<BookingReservationNotificationLinkRow | undefined> {
    const [row] = await tx.select().from(bookingReservationNotificationLinks).where(and(
      eq(bookingReservationNotificationLinks.eventId, eventId),
      eq(bookingReservationNotificationLinks.templateId, templateId),
    ));
    return row;
  }

  async listLatePaymentAttemptsForAlert(
    tx: Tx,
    input: { cutoff: Date; afterAttemptId?: string; limit: number },
  ): Promise<BookingReservationPaymentAttemptRow[]> {
    return tx.select().from(bookingReservationPaymentAttempts).where(and(
      eq(bookingReservationPaymentAttempts.status, 'succeeded'),
      eq(bookingReservationPaymentAttempts.successKind, 'late'),
      lte(bookingReservationPaymentAttempts.succeededAt, input.cutoff),
      input.afterAttemptId ? gt(bookingReservationPaymentAttempts.id, input.afterAttemptId) : undefined,
    )).orderBy(asc(bookingReservationPaymentAttempts.id)).limit(input.limit);
  }

  async insertNotificationLink(
    tx: Tx,
    values: typeof bookingReservationNotificationLinks.$inferInsert,
  ): Promise<BookingReservationNotificationLinkRow | undefined> {
    const [row] = await tx.insert(bookingReservationNotificationLinks).values(values).onConflictDoNothing().returning();
    return row;
  }

  async updateNotificationLink(
    tx: Tx,
    id: string,
    values: Partial<Pick<typeof bookingReservationNotificationLinks.$inferInsert, 'mappingStatus' | 'mappingFailureCode'>>,
    now: Date,
  ): Promise<BookingReservationNotificationLinkRow | undefined> {
    const [row] = await tx.update(bookingReservationNotificationLinks).set({ ...values, updatedAt: now })
      .where(eq(bookingReservationNotificationLinks.id, id)).returning();
    return row;
  }

  async listNotificationLinks(
    db: DrizzleDb | Tx,
    input: { reservationId: string; limit: number; offset: number },
  ): Promise<{ items: BookingReservationNotificationLinkRow[]; total: number }> {
    const where = eq(bookingReservationNotificationLinks.reservationId, input.reservationId);
    const items = await db.select().from(bookingReservationNotificationLinks).where(where)
      .orderBy(desc(bookingReservationNotificationLinks.createdAt), desc(bookingReservationNotificationLinks.id))
      .limit(input.limit).offset(input.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(bookingReservationNotificationLinks).where(where);
    return { items, total: Number(count) };
  }

  async nextRefundWorkerAttempt(tx: Tx, refundId: string, generation: number): Promise<number> {
    const result = await tx.execute<{ next_attempt: unknown }>(sql`
      SELECT coalesce(max(worker_attempt), 0) + 1 AS next_attempt
      FROM ${bookingReservationRefundInvocations}
      WHERE refund_id = ${refundId} AND generation = ${generation}
    `);
    return Number(result.rows[0]?.next_attempt);
  }

  async insertRefundInvocation(tx: Tx, values: typeof bookingReservationRefundInvocations.$inferInsert): Promise<BookingReservationRefundInvocationRow> {
    const [row] = await tx.insert(bookingReservationRefundInvocations).values(values).returning();
    return row!;
  }
}

export type ManagedReservationDetails = Partial<Pick<
  typeof bookingReservationReservations.$inferInsert,
  'bookerName' | 'bookerEmail' | 'bookerPhone' | 'primaryGuestName' | 'accommodationNotes'
>>;
