import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One editorial text, whatever layout the storefront gives it; `kind` picks the layout. */
export const contentArticles = pgTable('content_articles', {
  id: uuid('id').primaryKey(), kind: text('kind').notNull(), slug: text('slug').notNull(),
  title: text('title').notNull(), summary: text('summary').notNull().default(''),
  /** Free-form grouping shown above the title: a journal rubric, an FAQ category. */
  section: text('section').notNull().default(''),
  /** Blocks, not plain paragraphs: a story chapter carries its own heading. */
  body: jsonb('body').$type<{ heading: string | null; text: string }[]>().notNull().default([]),
  /** A closed, theme-owned key (ADR 0034); never a path or a URL. */
  imageKey: text('image_key'),
  /** B14 expands in place: published URLs and rows keep their identity while media moves to B10. */
  mediaAssetId: uuid('media_asset_id'),
  position: integer('position').notNull().default(0),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Durable evidence for a resumable Theme asset → B10 media import. */
export const contentLegacyMediaMappings = pgTable('content_legacy_media_mappings', {
  themeId: text('theme_id').notNull(), imageKey: text('image_key').notNull(), sourceDigest: text('source_digest').notNull(),
  mediaAssetId: uuid('media_asset_id'), status: text('status').notNull(), error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.themeId, table.imageKey, table.sourceDigest] })]);

/** A message a visitor sent from the storefront. The sender may be anonymous. */
export const contentContactMessages = pgTable('content_contact_messages', {
  id: uuid('id').primaryKey(), customerId: uuid('customer_id'),
  name: text('name').notNull(), email: text('email').notNull(), subject: text('subject').notNull(), message: text('message').notNull(),
  status: text('status').notNull().default('new'),
  handledByActorId: text('handled_by_actor_id'), handledAt: timestamp('handled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ContentArticleRow = typeof contentArticles.$inferSelect;
export type ContentContactMessageRow = typeof contentContactMessages.$inferSelect;
