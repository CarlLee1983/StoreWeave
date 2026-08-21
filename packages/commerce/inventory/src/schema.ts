import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const stock = pgTable('inventory_stock', {
  productId: uuid('product_id').primaryKey(),
  onHand: integer('on_hand').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const movements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull(),
  delta: integer('delta').notNull(),
  reason: text('reason').notNull(),
  reference: text('reference'),
  actorId: text('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StockRow = typeof stock.$inferSelect;
export type MovementRow = typeof movements.$inferSelect;
