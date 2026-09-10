import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 網站設定。獨立於 theme：換 theme 之後標語與頁尾附註還在（ADR 0046）。
 * 只有一列，`id` 固定是 `SITE_SETTINGS_ID`——設定是網站的屬性，不是一份清單。
 */
export const siteSettings = pgTable('platform_site_settings', {
  id: text('id').primaryKey(),
  tagline: text('tagline').notNull().default(''),
  footerNote: text('footer_note').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 導覽項目。menu 是 slug，平台不規定一個網站有哪幾組（ADR 0046）。
 */
export const siteNavigationItems = pgTable('platform_site_navigation_items', {
  id: uuid('id').primaryKey(),
  menu: text('menu').notNull(),
  /** 頁尾小標。同一組選單裡沒有分組的項目是 null。 */
  groupLabel: text('group_label'),
  label: text('label').notNull(),
  href: text('href').notNull(),
  position: integer('position').notNull().default(0),
  /** 要等這種內容有已發布的文章才出現；平台不解讀這個字串。 */
  requiresContentKind: text('requires_content_kind'),
});

export const SITE_SETTINGS_ID = 'site';

export type SiteSettingsRow = typeof siteSettings.$inferSelect;
export type SiteNavigationRow = typeof siteNavigationItems.$inferSelect;
