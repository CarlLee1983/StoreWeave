import { sqlMigration, type MigrationSet } from '@storeweave/db';

/**
 * 刻意不 INSERT 任何預設導覽：預設值由 release 在組裝時提供，資料庫只存店家改過的東西。
 * 把預設值寫進 migration 會讓「刪掉這一項」在下一次遷移後復活（ADR 0046）。
 */
export const siteMigrations: MigrationSet = {
  module: 'platform-site',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_site_settings (
  id text PRIMARY KEY,
  tagline text NOT NULL DEFAULT '',
  footer_note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.platform_site_navigation_items (
  id uuid PRIMARY KEY,
  menu text NOT NULL,
  group_label text,
  label text NOT NULL,
  href text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  requires_content_kind text
);
CREATE INDEX IF NOT EXISTS platform_site_navigation_items_menu_idx
  ON public.platform_site_navigation_items (menu, position);
`), sqlMigration('0002_contact_notification', 'expand', `
ALTER TABLE public.platform_site_settings ADD COLUMN IF NOT EXISTS contact_notification_email text;
`)],
};
