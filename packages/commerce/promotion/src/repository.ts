import { and, asc, eq, inArray, isNull, lte, gt, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { promotionRule, type PromotionDto } from './dto';
import { promotions, type PromotionRow } from './schema';

/**
 * 規則參數存在 jsonb 裡，讀回來一律重新驗證：資料庫的欄位型別擋不住
 * 舊資料、手動改動或程式改版留下的形狀。
 */
/** 解析失敗時回 null，讓呼叫端決定是要擋下還是跳過。 */
export function tryToPromotionDto(row: PromotionRow): PromotionDto | null {
  const rule = promotionRule.safeParse({ type: row.ruleType, ...(row.rule as Record<string, unknown>) });
  if (!rule.success) return null;
  return { ...toPromotionShell(row), rule: rule.data };
}

function toPromotionShell(row: PromotionRow): Omit<PromotionDto, 'rule'> {
  return {
    id: row.id,
    name: row.name,
    status: row.status as PromotionDto['status'],
    priority: row.priority,
    stackable: row.stackable,
    requiresCoupon: row.requiresCoupon,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPromotionDto(row: PromotionRow): PromotionDto {
  return {
    ...toPromotionShell(row),
    rule: promotionRule.parse({ type: row.ruleType, ...(row.rule as Record<string, unknown>) }),
  };
}

/** 在 `at` 這一刻生效中：含頭不含尾，與定價引擎的判斷一致。 */
function activeAtCondition(at: Date): SQL {
  return and(
    eq(promotions.status, 'active'),
    or(isNull(promotions.startsAt), lte(promotions.startsAt, at))!,
    or(isNull(promotions.endsAt), gt(promotions.endsAt, at))!,
  )!;
}

export class PromotionRepository {
  async insert(tx: Tx, values: typeof promotions.$inferInsert): Promise<PromotionRow> {
    const [row] = await tx.insert(promotions).values(values).returning();
    return row;
  }

  async update(tx: Tx, id: string, values: Partial<typeof promotions.$inferInsert>): Promise<PromotionRow | null> {
    const [row] = await tx.update(promotions).set(values).where(eq(promotions.id, id)).returning();
    return row ?? null;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<PromotionRow | null> {
    const [row] = await db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * 結帳熱路徑用的載入：不跑 count(*)（那會讓每一張訂單多一次全表統計），
   * 改成多取一列來判斷有沒有超出上限。
   */
  async listActiveAt(db: DrizzleDb | Tx, at: Date, limit: number): Promise<PromotionRow[]> {
    // 需要券的活動不在這裡：它們由呼叫端明確帶進來（`byIds`），
    // 否則建一張券就等於全站打折。
    return db
      .select()
      .from(promotions)
      .where(and(activeAtCondition(at), eq(promotions.requiresCoupon, false))!)
      .orderBy(asc(promotions.priority), asc(promotions.id))
      .limit(limit + 1);
  }

  /** 明確指名的活動：券所指向的那一條由這裡載入，生效判斷仍然一樣。 */
  async listActiveByIds(db: DrizzleDb | Tx, ids: readonly string[], at: Date): Promise<PromotionRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(promotions)
      .where(and(activeAtCondition(at), inArray(promotions.id, [...ids]))!)
      .orderBy(asc(promotions.priority), asc(promotions.id));
  }

  async list(
    db: DrizzleDb | Tx,
    filter: { status?: string; activeAt?: Date; limit: number; offset: number },
  ): Promise<{ items: PromotionRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(promotions.status, filter.status));
    if (filter.activeAt) conditions.push(activeAtCondition(filter.activeAt));
    const where = conditions.length ? and(...conditions)! : sql`true`;

    const items = await db
      .select()
      .from(promotions)
      .where(where)
      // 與定價引擎的套用順序相同：優先序，相同時以 id。
      .orderBy(asc(promotions.priority), asc(promotions.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(promotions).where(where);
    return { items, total: Number(count) };
  }
}
