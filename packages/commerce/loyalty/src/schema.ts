import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 購物金帳本。**只增不改**：折抵與回沖都是新的分錄，不是把某一列改掉。
 * 餘額由 `deriveRewardBalance` 推導，沒有餘額欄位可以被寫壞。
 */
export const rewardEntries = pgTable('loyalty_reward_entries', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull(),
  /** 正數是入帳，負數是折抵或扣回。 */
  amountCents: integer('amount_cents').notNull(),
  /** 這一筆是怎麼來的：訂單累積、結帳折抵、取消回沖、手動調整。 */
  source: text('source').notNull(),
  /** 對應的訂單或其他來源識別，供對帳追溯。 */
  reference: text('reference'),
  /** 什麼時候開始可用。付款後 N 天，避免「下單拿金、取消訂單、購物金留著」的套利。 */
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  /** 什麼時候過期；null 是不過期。 */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** 手動調整要記得是誰做的、為什麼。 */
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 購物金的累積規則。整個店鋪一組，因此是單列。 */
export const loyaltySettings = pgTable('loyalty_settings', {
  id: text('id').primaryKey(),
  /** 累積比例，基點。100 = 1%。 */
  accrualBasisPoints: integer('accrual_basis_points').notNull(),
  /** 付款後幾天生效。 */
  effectiveAfterDays: integer('effective_after_days').notNull(),
  /** 發放後幾天到期；null 是不過期。 */
  expiresAfterDays: integer('expires_after_days'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RewardEntryRow = typeof rewardEntries.$inferSelect;
export type LoyaltySettingsRow = typeof loyaltySettings.$inferSelect;
