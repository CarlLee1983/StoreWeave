import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { diningCapacityCommitments, diningDateOverrides, diningRequestSnapshots, diningTableTypes, diningVenues, diningWeeklyStarts } from './schema';
import { isWithinBookingWindow, offeredStartTimes, resolveLocalStart } from './schedule';
import type { DateOverride, SettingsDto, TableTypeDto, WeeklyStarts } from './types';

export function toSettingsDto(row: typeof diningVenues.$inferSelect): SettingsDto {
  return { id: row.id, name: row.name, timezone: row.timezone, occupancyMinutes: row.occupancyMinutes,
    minAdvanceMinutes: row.minAdvanceMinutes, maxAdvanceDays: row.maxAdvanceDays,
    createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function toTableTypeDto(row: typeof diningTableTypes.$inferSelect): TableTypeDto {
  return { id: row.id, capacity: row.capacity, count: row.count, active: row.active === 1,
    createdAt: row.createdAt, updatedAt: row.updatedAt };
}

type Occupancy = { startAt: Date; endAt: Date };
type CapacityCommitment = typeof diningCapacityCommitments.$inferSelect;

function capacityDecisionClock(earliestAt: Date) {
  return sql`decision_clock AS MATERIALIZED (
    SELECT greatest(${earliestAt.toISOString()}::timestamptz, pg_catalog.clock_timestamp()) AS decided_at
  )`;
}

export function diningRequestDecision({ acceptedAt, cancelledAt, rejectedAt }: {
  acceptedAt: Date | null; cancelledAt: Date | null; rejectedAt: Date | null;
}) {
  if (cancelledAt) return { status: 'cancelled' as const, decidedAt: cancelledAt };
  if (acceptedAt) return { status: 'accepted' as const, decidedAt: acceptedAt };
  if (rejectedAt) return { status: 'rejected' as const, decidedAt: rejectedAt };
  return { status: 'pending' as const, decidedAt: null };
}

function peakConcurrent(intervals: Occupancy[]): number {
  const events = intervals.flatMap(interval => [
    { at: interval.startAt.getTime(), change: 1 },
    { at: interval.endAt.getTime(), change: -1 },
  ]).sort((a, b) => a.at - b.at || a.change - b.change);
  let occupied = 0;
  let peak = 0;
  for (const event of events) {
    occupied += event.change;
    peak = Math.max(peak, occupied);
  }
  return peak;
}

export class DiningReservationRepository {
  async getSettings(db: DrizzleDb | Tx) {
    const [row] = await db.select().from(diningVenues).where(eq(diningVenues.singletonSlot, 1)).limit(1);
    return row ?? null;
  }

  async lockSettings(tx: Tx) {
    const [row] = await tx.select().from(diningVenues).where(eq(diningVenues.singletonSlot, 1)).limit(1).for('update');
    return row ?? null;
  }

  async listTableTypes(db: DrizzleDb | Tx) {
    return db.select().from(diningTableTypes).orderBy(asc(diningTableTypes.capacity));
  }

  async listWeekly(db: DrizzleDb | Tx): Promise<WeeklyStarts[]> {
    const rows = await db.select().from(diningWeeklyStarts).orderBy(asc(diningWeeklyStarts.weekday));
    return rows.map(row => ({ weekday: row.weekday, startTimes: row.startTimes }));
  }

  async listOverrides(db: DrizzleDb | Tx): Promise<DateOverride[]> {
    const rows = await db.select().from(diningDateOverrides).orderBy(asc(diningDateOverrides.date));
    return rows.map(row => ({ date: row.date, startTimes: row.startTimes }));
  }

  /** Pending requests have no commitment and therefore never occupy a table. */
  private async availableTable(db: DrizzleDb | Tx, partySize: number, startAt: Date, endAt: Date) {
    const occupied = await db.select({
      tableTypeId: diningCapacityCommitments.tableTypeId,
      startAt: diningRequestSnapshots.startAt, endAt: diningRequestSnapshots.endAt,
    }).from(diningCapacityCommitments)
      .innerJoin(diningRequestSnapshots, eq(diningCapacityCommitments.requestId, diningRequestSnapshots.id))
      .where(and(isNull(diningCapacityCommitments.cancelledAt),
        lt(diningRequestSnapshots.startAt, endAt), gt(diningRequestSnapshots.endAt, startAt)));
    for (const type of await this.listTableTypes(db)) {
      if (type.active !== 1 || type.capacity < partySize || type.count === 0) continue;
      if (peakConcurrent([...occupied.filter(row => row.tableTypeId === type.id), { startAt, endAt }]) <= type.count) return type;
    }
    return null;
  }

  async hasAvailableTable(db: DrizzleDb | Tx, partySize: number, startAt: Date, endAt: Date): Promise<boolean> {
    return (await this.availableTable(db, partySize, startAt, endAt)) !== null;
  }

  /** SW-166 calls this inside its request transaction, after its own eligibility checks. */
  async insertRequestSnapshot(tx: Tx, input: {
    id?: string; date: string; time: string; partySize: number; createdAt: Date;
  }) {
    const venue = await this.lockSettings(tx);
    if (!venue) throw PlatformError.conflict('Configure the Dining venue before accepting requests');
    const weekly = await this.listWeekly(tx);
    const overrides = await this.listOverrides(tx);
    if (!offeredStartTimes(input.date, weekly, overrides).includes(input.time)) {
      throw PlatformError.conflict('This Dining start is closed');
    }
    const startAt = resolveLocalStart(input.date, input.time, venue.timezone);
    if (!startAt) throw PlatformError.conflict('This Dining start is unavailable in the venue timezone');
    if (!isWithinBookingWindow(startAt, input.createdAt, {
      minAdvanceMinutes: venue.minAdvanceMinutes, maxAdvanceDays: venue.maxAdvanceDays,
    })) throw PlatformError.conflict('This Dining start is outside the booking window');
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 1000) {
      throw PlatformError.validation('Party size must be between 1 and 1000');
    }
    const [row] = await tx.insert(diningRequestSnapshots).values({
      id: input.id ?? randomUUID(), venueId: venue.id, startAt,
      endAt: new Date(startAt.getTime() + venue.occupancyMinutes * 60_000), startDate: input.date,
      startTime: input.time, timezone: venue.timezone, partySize: input.partySize,
      occupancyMinutes: venue.occupancyMinutes, minAdvanceMinutes: venue.minAdvanceMinutes,
      maxAdvanceDays: venue.maxAdvanceDays, createdAt: input.createdAt,
    }).returning();
    return row!;
  }

  /** Accept inside the caller's transaction. Every competing write locks the venue first. */
  async commitCapacity(tx: Tx, requestId: string, now: Date) {
    const venue = await this.lockSettings(tx);
    if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
    const [request] = await tx.select().from(diningRequestSnapshots)
      .where(and(eq(diningRequestSnapshots.id, requestId), eq(diningRequestSnapshots.venueId, venue.id)))
      .limit(1).for('key share');
    if (!request) throw PlatformError.notFound('Dining request', requestId);
    if (request.startAt <= now) throw PlatformError.conflict('This Dining start has passed');
    const [existing] = await tx.select({ requestId: diningCapacityCommitments.requestId })
      .from(diningCapacityCommitments).where(eq(diningCapacityCommitments.requestId, requestId)).limit(1);
    if (existing) throw PlatformError.conflict('This Dining request already has a capacity commitment');
    if (!offeredStartTimes(request.startDate, await this.listWeekly(tx), await this.listOverrides(tx))
      .includes(request.startTime)) throw PlatformError.conflict('This Dining start is closed');

    const type = await this.availableTable(tx, request.partySize, request.startAt, request.endAt);
    if (!type) throw PlatformError.conflict('No Dining table type has capacity for this interval');
    // Lock both foreign-key rows before the INSERT takes its relation lock and samples the clock.
    await tx.select({ id: diningTableTypes.id }).from(diningTableTypes)
      .where(eq(diningTableTypes.id, type.id)).for('key share');
    const { rows: [commitment] } = await tx.execute<Omit<CapacityCommitment, 'acceptedAt' | 'cancelledAt'> & { acceptedAt: string }>(sql`
      WITH ${capacityDecisionClock(now)}
      INSERT INTO ${diningCapacityCommitments} (request_id, table_type_id, table_type_capacity, accepted_at)
      SELECT snapshot.id, ${type.id}, ${type.capacity}, decision_clock.decided_at
      FROM ${diningRequestSnapshots} AS snapshot CROSS JOIN decision_clock
      WHERE snapshot.id = ${requestId} AND decision_clock.decided_at < snapshot.start_at
      RETURNING request_id AS "requestId", table_type_id AS "tableTypeId", table_type_capacity AS "tableTypeCapacity",
        accepted_at AS "acceptedAt"
    `);
    if (!commitment) throw PlatformError.conflict('This Dining start has passed');
    return { ...commitment, acceptedAt: new Date(commitment.acceptedAt), cancelledAt: null };
  }

  /** Cancellation releases capacity; the accepted fact and table snapshot remain. */
  async cancelCapacity(tx: Tx, requestId: string, now: Date) {
    const venue = await this.lockSettings(tx);
    if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
    const [commitment] = await tx.select({
      tableTypeId: diningCapacityCommitments.tableTypeId,
      tableTypeCapacity: diningCapacityCommitments.tableTypeCapacity,
      cancelledAt: diningCapacityCommitments.cancelledAt,
      acceptedAt: diningCapacityCommitments.acceptedAt,
    }).from(diningCapacityCommitments)
      .innerJoin(diningRequestSnapshots, eq(diningCapacityCommitments.requestId, diningRequestSnapshots.id))
      .where(and(eq(diningCapacityCommitments.requestId, requestId), eq(diningRequestSnapshots.venueId, venue.id)))
      .limit(1).for('update', { of: diningCapacityCommitments });
    if (!commitment) throw PlatformError.notFound('Dining capacity commitment', requestId);
    if (commitment.cancelledAt) throw PlatformError.conflict('This Dining commitment is already cancelled');
    const { rows: [result] } = await tx.execute<{ started: boolean; cancelledAt: string | null }>(sql`
      WITH ${capacityDecisionClock(now)},
      eligibility AS MATERIALIZED (
        SELECT snapshot.start_at <= decision_clock.decided_at AS started, decision_clock.decided_at
        FROM ${diningRequestSnapshots} AS snapshot CROSS JOIN decision_clock
        WHERE snapshot.id = ${requestId}
      ), cancellation AS (
        UPDATE ${diningCapacityCommitments} AS commitment
        SET cancelled_at = eligibility.decided_at
        FROM eligibility
        WHERE commitment.request_id = ${requestId} AND NOT eligibility.started
          AND eligibility.decided_at >= commitment.accepted_at
        RETURNING commitment.cancelled_at
      )
      SELECT eligibility.started, cancellation.cancelled_at AS "cancelledAt"
      FROM eligibility LEFT JOIN cancellation ON true
    `);
    const { started, cancelledAt } = result!;
    if (started) throw PlatformError.conflict('This Dining reservation has started');
    if (!cancelledAt) throw PlatformError.validation('Cancellation cannot precede acceptance');
    return { requestId, tableTypeId: commitment.tableTypeId, tableTypeCapacity: commitment.tableTypeCapacity,
      acceptedAt: commitment.acceptedAt, cancelledAt: new Date(cancelledAt) };
  }

  /** Called after locking the venue and before changing a table type. */
  async assertTableTypeEditSafe(tx: Tx, tableTypeId: string, capacity: number, count: number, now: Date) {
    const active = await tx.select({
      partySize: diningRequestSnapshots.partySize,
      startAt: diningRequestSnapshots.startAt, endAt: diningRequestSnapshots.endAt,
    }).from(diningCapacityCommitments)
      .innerJoin(diningRequestSnapshots, eq(diningCapacityCommitments.requestId, diningRequestSnapshots.id))
      .where(and(eq(diningCapacityCommitments.tableTypeId, tableTypeId),
        isNull(diningCapacityCommitments.cancelledAt), gt(diningRequestSnapshots.endAt, now)));
    if (active.some(row => row.partySize > capacity) || peakConcurrent(active) > count) {
      throw PlatformError.conflict('This Dining table change would invalidate an accepted reservation');
    }
  }
}
