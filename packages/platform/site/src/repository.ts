import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { SITE_SETTINGS_ID, siteNavigationItems, siteSettings, type SiteNavigationRow, type SiteSettingsRow } from './schema';
import type { SiteNavigationItem, SiteSettings } from './types';

/** 還沒有人動過設定時的樣子。空字串而不是 null：Theme 拿到的永遠是可直接輸出的值。 */
export const EMPTY_SITE_SETTINGS: SiteSettings = { tagline: '', footerNote: '' };

export function toSiteSettings(row: SiteSettingsRow | undefined): SiteSettings {
  return row ? { tagline: row.tagline, footerNote: row.footerNote } : EMPTY_SITE_SETTINGS;
}

export function toNavigationItem(row: SiteNavigationRow): SiteNavigationItem {
  return {
    menu: row.menu, groupLabel: row.groupLabel, label: row.label,
    href: row.href, position: row.position, requiresContentKind: row.requiresContentKind,
  };
}

export class SiteRepository {
  async settings(db: DrizzleDb | Tx): Promise<SiteSettings> {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, SITE_SETTINGS_ID)).limit(1);
    return toSiteSettings(row);
  }

  async navigation(db: DrizzleDb | Tx): Promise<readonly SiteNavigationItem[]> {
    const rows = await db.select().from(siteNavigationItems)
      .orderBy(asc(siteNavigationItems.menu), asc(siteNavigationItems.position));
    return rows.map(toNavigationItem);
  }

  /** 設定是單列 upsert：第一次寫入建立它，之後就地更新。 */
  async saveSettings(tx: Tx, values: Partial<SiteSettings>, now: Date): Promise<SiteSettings> {
    const current = await this.settings(tx);
    const next = { ...current, ...values };
    const [row] = await tx.insert(siteSettings)
      .values({ id: SITE_SETTINGS_ID, ...next, updatedAt: now })
      .onConflictDoUpdate({ target: siteSettings.id, set: { ...next, updatedAt: now } })
      .returning();
    return toSiteSettings(row);
  }

  /**
   * 一整組選單一次換掉。逐項編輯需要每一項有穩定 id，而導覽的實際編輯動作是
   * 「重排、改名、刪掉一項」——整組取代讓那些動作各自都是一次寫入，不是三種 API。
   */
  async replaceMenu(tx: Tx, menu: string, items: readonly Omit<SiteNavigationItem, 'menu'>[]): Promise<number> {
    await tx.delete(siteNavigationItems).where(eq(siteNavigationItems.menu, menu));
    if (items.length === 0) return 0;
    await tx.insert(siteNavigationItems).values(items.map(item => ({ id: randomUUID(), menu, ...item })));
    return items.length;
  }
}
