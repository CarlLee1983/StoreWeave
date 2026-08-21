import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** ORM entity —— 內部使用。絕不作為公開契約回傳，一律先轉成 DTO。 */
export const products = pgTable('catalog_products', {
  id: uuid('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProductRow = typeof products.$inferSelect;
