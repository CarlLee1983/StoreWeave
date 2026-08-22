import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
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

  async redemptionForOrder(db: DrizzleDb | Tx, orderId: string): Promise<CouponRedemptionRow | null> {
    const [row] = await db
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.orderId, orderId))
      .limit(1);
    return row ?? null;
  }
}
