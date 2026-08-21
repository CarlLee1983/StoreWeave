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
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PromotionRow = typeof promotions.$inferSelect;
