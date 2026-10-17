import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const notes = pgTable('notes_entries', {
  id: uuid('id').primaryKey(),
  ownerActorId: text('owner_actor_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<'draft' | 'published'>().notNull(),
  revision: integer('revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
