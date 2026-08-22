import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const promotions = pgTable('promotion_promotions', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  ruleType: text('rule_type').notNull(),
  /** 規則參數。型別已在 rule_type，這裡只放該型別的參數。 */
  rule: jsonb('rule').notNull(),
  priority: integer('priority').notNull().default(0),
  stackable: boolean('stackable').notNull().default(true),
  /** 需要券才套用。這種活動不會出現在「此刻人人適用」的清單裡。 */
  requiresCoupon: boolean('requires_coupon').notNull().default(false),
  /** 自動發券的觸發：`signup`、`birthday`，或 null（不自動發）。 */
  autoIssue: text('auto_issue'),
  /** 只有這些等級適用。空陣列代表人人適用。 */
  tierNames: text('tier_names').array().notNull().default([]),
  /** 自動發出的券幾天後到期。null 是不設到期日。 */
  autoIssueValidDays: integer('auto_issue_valid_days'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PromotionRow = typeof promotions.$inferSelect;
