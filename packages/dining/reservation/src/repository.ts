import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';
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
    const effectiveNow = new Date(Math.max(now.getTime(), Date.now()));
    const [request] = await tx.select().from(diningRequestSnapshots)
      .where(and(eq(diningRequestSnapshots.id, requestId), eq(diningRequestSnapshots.venueId, venue.id))).limit(1);
    if (!request) throw PlatformError.notFound('Dining request', requestId);
    if (request.startAt <= effectiveNow) throw PlatformError.conflict('This Dining start has passed');
    const [existing] = await tx.select({ requestId: diningCapacityCommitments.requestId })
      .from(diningCapacityCommitments).where(eq(diningCapacityCommitments.requestId, requestId)).limit(1);
    if (existing) throw PlatformError.conflict('This Dining request already has a capacity commitment');
    if (!offeredStartTimes(request.startDate, await this.listWeekly(tx), await this.listOverrides(tx))
      .includes(request.startTime)) throw PlatformError.conflict('This Dining start is closed');

    const occupied = await tx.select({
      tableTypeId: diningCapacityCommitments.tableTypeId,
      startAt: diningRequestSnapshots.startAt, endAt: diningRequestSnapshots.endAt,
    }).from(diningCapacityCommitments)
      .innerJoin(diningRequestSnapshots, eq(diningCapacityCommitments.requestId, diningRequestSnapshots.id))
      .where(and(isNull(diningCapacityCommitments.cancelledAt),
        lt(diningRequestSnapshots.startAt, request.endAt), gt(diningRequestSnapshots.endAt, request.startAt)));
    for (const type of await this.listTableTypes(tx)) {
      if (type.active !== 1 || type.capacity < request.partySize || type.count === 0) continue;
      const overlapping = occupied.filter(row => row.tableTypeId === type.id);
      if (peakConcurrent([...overlapping, request]) > type.count) continue;
      const [commitment] = await tx.insert(diningCapacityCommitments).values({
        requestId, tableTypeId: type.id, tableTypeCapacity: type.capacity, acceptedAt: effectiveNow,
      }).returning();
      return commitment!;
    }
    throw PlatformError.conflict('No Dining table type has capacity for this interval');
  }

  /** Cancellation releases capacity; the accepted fact and table snapshot remain. */
  async cancelCapacity(tx: Tx, requestId: string, now: Date) {
    const venue = await this.lockSettings(tx);
    if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
    const effectiveNow = new Date(Math.max(now.getTime(), Date.now()));
    const [commitment] = await tx.select({
      requestId: diningCapacityCommitments.requestId,
      cancelledAt: diningCapacityCommitments.cancelledAt,
      acceptedAt: diningCapacityCommitments.acceptedAt,
      startAt: diningRequestSnapshots.startAt,
    }).from(diningCapacityCommitments)
      .innerJoin(diningRequestSnapshots, eq(diningCapacityCommitments.requestId, diningRequestSnapshots.id))
      .where(and(eq(diningCapacityCommitments.requestId, requestId), eq(diningRequestSnapshots.venueId, venue.id))).limit(1);
    if (!commitment) throw PlatformError.notFound('Dining capacity commitment', requestId);
    if (commitment.cancelledAt) throw PlatformError.conflict('This Dining commitment is already cancelled');
    if (commitment.startAt <= effectiveNow) throw PlatformError.conflict('This Dining reservation has started');
    if (effectiveNow < commitment.acceptedAt) throw PlatformError.validation('Cancellation cannot precede acceptance');
    const [row] = await tx.update(diningCapacityCommitments).set({ cancelledAt: effectiveNow })
      .where(eq(diningCapacityCommitments.requestId, requestId)).returning();
    return row!;
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
