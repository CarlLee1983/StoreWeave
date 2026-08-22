import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import {
  customerTiers, loyaltySettings, rewardEntries, tierEntries, tiers,
  type CustomerTierRow, type LoyaltySettingsRow, type RewardEntryRow, type TierEntryRow, type TierRow,
} from './schema';

const SETTINGS_ID = 'singleton';

export class LoyaltyRepository {
  /** 一位顧客的整本帳。餘額是它的推導值，因此每次都要讀完。 */
  async rewardEntriesFor(db: DrizzleDb | Tx, customerId: string): Promise<RewardEntryRow[]> {
    return db
      .select()
      .from(rewardEntries)
      .where(eq(rewardEntries.customerId, customerId))
      .orderBy(asc(rewardEntries.createdAt), asc(rewardEntries.id));
  }

  /**
   * 寫一筆分錄。`reference` 撞上就當作已經寫過並回 null——
   * 同一張訂單只累積一次、只回沖一次，靠唯一索引而不是先查一次。
   */
  async addRewardEntry(tx: Tx, values: typeof rewardEntries.$inferInsert): Promise<RewardEntryRow | null> {
    const [row] = await tx.insert(rewardEntries).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async settings(db: DrizzleDb | Tx): Promise<LoyaltySettingsRow> {
    const [row] = await db.select().from(loyaltySettings).where(eq(loyaltySettings.id, SETTINGS_ID)).limit(1);
    // 設定由 migration 建立；讀不到代表 migration 沒跑完，這時候安靜地用預設值會更難查。
    if (!row) throw new Error('Loyalty settings row is missing; run migrations');
    return row;
  }

  async updateSettings(tx: Tx, patch: Partial<typeof loyaltySettings.$inferInsert>): Promise<LoyaltySettingsRow> {
    const [row] = await tx
      .update(loyaltySettings)
      .set(patch)
      .where(eq(loyaltySettings.id, SETTINGS_ID))
      .returning();
    return row;
  }

  /**
   * 流通在外的購物金。這是一本負債帳，經營者要看得出自己背了多少。
   *
   * 精確的可用金額需要逐人推導（先到期先用），資料量大時不能在報表裡做。
   * 這裡回的是帳本淨額——它與逐人推導的差異只在「扣抵超過餘額」這種不該存在的情況。
   */
  async outstandingRewards(
    db: DrizzleDb | Tx,
    now: Date,
  ): Promise<{ availableCents: number; pendingCents: number; customerCount: number }> {
    const [row] = await db
      .select({
        availableCents: sql<number>`coalesce(sum(${rewardEntries.amountCents}) FILTER (
          WHERE ${rewardEntries.effectiveAt} <= ${now}
            AND (${rewardEntries.expiresAt} IS NULL OR ${rewardEntries.expiresAt} > ${now})
        ), 0)::int`,
        pendingCents: sql<number>`coalesce(sum(${rewardEntries.amountCents}) FILTER (
          WHERE ${rewardEntries.effectiveAt} > ${now}
        ), 0)::int`,
        customerCount: sql<number>`count(DISTINCT ${rewardEntries.customerId})::int`,
      })
      .from(rewardEntries);
    return {
      availableCents: Math.max(0, Number(row.availableCents)),
      pendingCents: Math.max(0, Number(row.pendingCents)),
      customerCount: Number(row.customerCount),
    };
  }

  /** 一位顧客的等級積分帳本。等級是它的推導值。 */
  async tierEntriesFor(db: DrizzleDb | Tx, customerId: string): Promise<TierEntryRow[]> {
    return db
      .select()
      .from(tierEntries)
      .where(eq(tierEntries.customerId, customerId))
      .orderBy(asc(tierEntries.earnedAt), asc(tierEntries.id));
  }

  async addTierEntry(tx: Tx, values: typeof tierEntries.$inferInsert): Promise<TierEntryRow | null> {
    const [row] = await tx.insert(tierEntries).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async tiers(db: DrizzleDb | Tx): Promise<TierRow[]> {
    return db.select().from(tiers).orderBy(asc(tiers.thresholdPoints));
  }

  async upsertTier(tx: Tx, values: typeof tiers.$inferInsert): Promise<TierRow> {
    const [row] = await tx
      .insert(tiers)
      .values(values)
      .onConflictDoUpdate({
        target: tiers.name,
        set: {
          thresholdPoints: values.thresholdPoints,
          multiplierBasisPoints: values.multiplierBasisPoints,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    return row;
  }

  async deleteTier(tx: Tx, name: string): Promise<number> {
    const deleted = await tx.delete(tiers).where(eq(tiers.name, name)).returning({ name: tiers.name });
    return deleted.length;
  }

  async customerTier(db: DrizzleDb | Tx, customerId: string): Promise<CustomerTierRow | null> {
    const [row] = await db.select().from(customerTiers).where(eq(customerTiers.customerId, customerId)).limit(1);
    return row ?? null;
  }

  /** 快取目前的等級。真相永遠是帳本，這只是讓熱路徑不必每次重算整本帳。 */
  async saveCustomerTier(tx: Tx, values: typeof customerTiers.$inferInsert): Promise<CustomerTierRow> {
    const [row] = await tx
      .insert(customerTiers)
      .values(values)
      .onConflictDoUpdate({
        target: customerTiers.customerId,
        set: {
          tierName: values.tierName,
          points: values.points,
          previousTierName: values.previousTierName,
          recalculatedAt: values.recalculatedAt,
        },
      })
      .returning();
    return row;
  }

  /** 有等級積分紀錄的顧客。重算掃這一份清單。 */
  async customersWithTierPoints(db: DrizzleDb | Tx): Promise<string[]> {
    const rows = await db
      .selectDistinct({ customerId: tierEntries.customerId })
      .from(tierEntries)
      .orderBy(asc(tierEntries.customerId));
    return rows.map((row) => row.customerId);
  }

  /** 快到期而且還沒用掉的批次。到期通知掃它（工單 48）。 */
  async expiringBatches(
    db: DrizzleDb | Tx,
    range: { from: Date; to: Date },
  ): Promise<RewardEntryRow[]> {
    return db
      .select()
      .from(rewardEntries)
      .where(and(
        isNotNull(rewardEntries.expiresAt),
        sql`${rewardEntries.expiresAt} >= ${range.from}`,
        sql`${rewardEntries.expiresAt} < ${range.to}`,
        sql`${rewardEntries.amountCents} > 0`,
      )!)
      .orderBy(asc(rewardEntries.customerId), asc(rewardEntries.expiresAt));
  }
}
