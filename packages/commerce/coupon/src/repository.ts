import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import type { CouponDto } from './dto';
import { couponRedemptions, coupons, type CouponRedemptionRow, type CouponRow } from './schema';

export function toCouponDto(row: CouponRow): CouponDto {
  return {
    id: row.id,
    code: row.code,
    promotionId: row.promotionId,
    status: row.status as CouponDto['status'],
    customerId: row.customerId,
    partnerCode: row.partnerCode,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    perCustomerLimit: row.perCustomerLimit,
    source: row.source,
    batchId: row.batchId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CouponRepository {
  async insert(tx: Tx, values: typeof coupons.$inferInsert): Promise<CouponRow> {
    const [row] = await tx.insert(coupons).values(values).returning();
    return row;
  }

  /**
   * 發一張券。`issue_key` 撞上就當作已經發過——回 null 而不是丟錯。
   * 事件重投與排程重跑是常態，不是例外。
   */
  async issue(tx: Tx, values: typeof coupons.$inferInsert): Promise<CouponRow | null> {
    const [row] = await tx.insert(coupons).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<CouponRow | null> {
    const [row] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    return row ?? null;
  }

  /** 一律以大寫比對：顧客打小寫、客服念錯大小寫都要能對上同一張券。 */
  async findByCode(db: DrizzleDb | Tx, code: string): Promise<CouponRow | null> {
    const [row] = await db
      .select()
      .from(coupons)
      .where(sql`upper(${coupons.code}) = upper(${code})`)
      .limit(1);
    return row ?? null;
  }

  /** 核銷要鎖住那一列：限量與每人限用一次都建立在這把鎖上（工單 32）。 */
  async lockById(tx: Tx, id: string): Promise<CouponRow | null> {
    const [row] = await tx.select().from(coupons).where(eq(coupons.id, id)).limit(1).for('update');
    return row ?? null;
  }

  async update(tx: Tx, id: string, values: Partial<typeof coupons.$inferInsert>): Promise<CouponRow | null> {
    const [row] = await tx.update(coupons).set(values).where(eq(coupons.id, id)).returning();
    return row ?? null;
  }

  async list(
    db: DrizzleDb | Tx,
    filter: { status?: string; promotionId?: string; customerId?: string; limit: number; offset: number },
  ): Promise<{ items: CouponRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(coupons.status, filter.status));
    if (filter.promotionId) conditions.push(eq(coupons.promotionId, filter.promotionId));
    if (filter.customerId) conditions.push(eq(coupons.customerId, filter.customerId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await db
      .select()
      .from(coupons)
      .where(where)
      .orderBy(desc(coupons.createdAt), desc(coupons.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(coupons).where(where);
    return { items, total: Number(count) };
  }

  /**
   * 扣一次額度。**條件更新**：只在還有剩餘時扣得動，扣不到就回 false。
   * 先讀後寫在併發下會超發，而超發的是店家的錢。
   */
  async consume(tx: Tx, couponId: string, now: Date): Promise<boolean> {
    const updated = await tx
      .update(coupons)
      .set({ redeemedCount: sql`${coupons.redeemedCount} + 1`, updatedAt: now })
      .where(and(
        eq(coupons.id, couponId),
        sql`(${coupons.maxRedemptions} IS NULL OR ${coupons.redeemedCount} < ${coupons.maxRedemptions})`,
      )!)
      .returning({ id: coupons.id });
    return updated.length > 0;
  }

  /** 回補一次額度。訂單取消時用（工單 37）。 */
  async release(tx: Tx, couponId: string, now: Date): Promise<void> {
    await tx
      .update(coupons)
      .set({ redeemedCount: sql`greatest(${coupons.redeemedCount} - 1, 0)`, updatedAt: now })
      .where(eq(coupons.id, couponId));
  }

  /** 這位顧客核銷過這條規則幾次。「每人限用一次」看的是規則，不是券。 */
  async redemptionCountFor(db: DrizzleDb | Tx, promotionId: string, customerId: string): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(and(
        eq(couponRedemptions.promotionId, promotionId),
        eq(couponRedemptions.customerId, customerId),
        // 回沖過的不算：顧客取消了訂單，他就沒有用過。
        isNull(couponRedemptions.reversedAt),
      )!);
    return Number(count);
  }

  /** 這張訂單還有效的核銷。取消時要回沖的就是它。 */
  async activeRedemptionForOrder(db: DrizzleDb | Tx, orderId: string): Promise<CouponRedemptionRow | null> {
    const [row] = await db
      .select()
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.orderId, orderId), isNull(couponRedemptions.reversedAt))!)
      .limit(1);
    return row ?? null;
  }

  async markRedemptionReversed(tx: Tx, id: string, now: Date): Promise<void> {
    await tx.update(couponRedemptions).set({ reversedAt: now }).where(eq(couponRedemptions.id, id));
  }

  async recordRedemption(
    tx: Tx,
    values: Omit<typeof couponRedemptions.$inferInsert, 'id'>,
  ): Promise<CouponRedemptionRow> {
    const [row] = await tx.insert(couponRedemptions).values({ id: randomUUID(), ...values }).returning();
    return row;
  }

  async redemptionsFor(db: DrizzleDb | Tx, couponId: string): Promise<CouponRedemptionRow[]> {
    return db
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.couponId, couponId))
      .orderBy(desc(couponRedemptions.redeemedAt));
  }

  /**
   * 依合作夥伴分組的成效。查的是核銷明細本身——這張表就是行銷分析的事實來源，
   * 報表不掃訂單全表（Spec 0004）。
   */
  async attributionSummary(
    db: DrizzleDb | Tx,
    filter: { from?: Date; to?: Date; partnerCode?: string },
  ): Promise<{ partnerCode: string; orderCount: number; revenueCents: number; discountCents: number }[]> {
    const conditions: SQL[] = [
      sql`${couponRedemptions.partnerCode} IS NOT NULL`,
      // 回沖過的核銷不算業績：訂單已經不存在了。
      isNull(couponRedemptions.reversedAt),
    ];
    if (filter.from) conditions.push(gte(couponRedemptions.redeemedAt, filter.from));
    if (filter.to) conditions.push(lt(couponRedemptions.redeemedAt, filter.to));
    if (filter.partnerCode) conditions.push(eq(couponRedemptions.partnerCode, filter.partnerCode));

    const rows = await db
      .select({
        partnerCode: couponRedemptions.partnerCode,
        orderCount: sql<number>`count(DISTINCT ${couponRedemptions.orderId})::int`,
        revenueCents: sql<number>`coalesce(sum(${couponRedemptions.orderTotalCents}), 0)::int`,
        discountCents: sql<number>`coalesce(sum(${couponRedemptions.discountCents}), 0)::int`,
      })
      .from(couponRedemptions)
      .where(and(...conditions)!)
      .groupBy(couponRedemptions.partnerCode)
      .orderBy(desc(sql`coalesce(sum(${couponRedemptions.orderTotalCents}), 0)`), couponRedemptions.partnerCode);

    return rows.map((row) => ({
      partnerCode: row.partnerCode!,
      orderCount: Number(row.orderCount),
      revenueCents: Number(row.revenueCents),
      discountCents: Number(row.discountCents),
    }));
  }

  /**
   * 每一檔活動的成效。查的是核銷明細——它天生比訂單表小得多，
   * 而且本來就是為了這件事存在的（Spec 0004、0005）。不建 projection。
   */
  async promotionPerformance(
    db: DrizzleDb | Tx,
    filter: { from?: Date; to?: Date },
  ): Promise<{ promotionId: string; redemptionCount: number; orderCount: number; discountCents: number; revenueCents: number }[]> {
    const conditions: SQL[] = [isNull(couponRedemptions.reversedAt)];
    if (filter.from) conditions.push(gte(couponRedemptions.redeemedAt, filter.from));
    if (filter.to) conditions.push(lt(couponRedemptions.redeemedAt, filter.to));

    const rows = await db
      .select({
        promotionId: couponRedemptions.promotionId,
        redemptionCount: sql<number>`count(*)::int`,
        orderCount: sql<number>`count(DISTINCT ${couponRedemptions.orderId})::int`,
        discountCents: sql<number>`coalesce(sum(${couponRedemptions.discountCents}), 0)::int`,
        revenueCents: sql<number>`coalesce(sum(${couponRedemptions.orderTotalCents}), 0)::int`,
      })
      .from(couponRedemptions)
      .where(and(...conditions)!)
      .groupBy(couponRedemptions.promotionId)
      .orderBy(desc(sql`coalesce(sum(${couponRedemptions.discountCents}), 0)`));

    return rows.map((row) => ({
      promotionId: row.promotionId,
      redemptionCount: Number(row.redemptionCount),
      orderCount: Number(row.orderCount),
      discountCents: Number(row.discountCents),
      revenueCents: Number(row.revenueCents),
    }));
  }

  async redemptionForOrder(db: DrizzleDb | Tx, orderId: string): Promise<CouponRedemptionRow | null> {
    const [row] = await db
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.orderId, orderId))
      .limit(1);
    return row ?? null;
  }
}
