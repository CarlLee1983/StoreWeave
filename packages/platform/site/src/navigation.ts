import type { ThemeNavigation, ThemeNavigationItem } from '@storeweave/kernel';
import type { SiteNavigationItem } from './types';

/** 補齊選填欄位的建構子，讓 release 的預設導覽寫起來不必逐項填 null。 */
export function navigationItem(item: {
  menu: string; label: string; href: string; position: number;
  groupLabel?: string; requiresContentKind?: string;
}): SiteNavigationItem {
  return {
    menu: item.menu,
    groupLabel: item.groupLabel ?? null,
    label: item.label,
    href: item.href,
    position: item.position,
    requiresContentKind: item.requiresContentKind ?? null,
  };
}

const byPosition = (a: SiteNavigationItem, b: SiteNavigationItem): number => a.position - b.position;

/**
 * 資料庫有的 menu 用資料庫的，沒有的用 release 預設值。以 menu 為單位而不是整張表：
 * 改了主導覽不該連頁尾一起消失（ADR 0046）。
 */
export function resolveNavigation(
  stored: readonly SiteNavigationItem[], defaults: readonly SiteNavigationItem[],
): readonly SiteNavigationItem[] {
  const storedMenus = new Set(stored.map(item => item.menu));
  const merged = [...stored, ...defaults.filter(item => !storedMenus.has(item.menu))];
  // 每一組各自排序而不是整份排序：兩組選單的 position 是獨立的座標，
  // 混在一起排會讓頁尾的第一項插進主導覽中間。
  const menus = new Map<string, SiteNavigationItem[]>();
  for (const item of merged) {
    const group = menus.get(item.menu);
    if (group) group.push(item); else menus.set(item.menu, [item]);
  }
  return [...menus.values()].flatMap(group => group.slice().sort(byPosition));
}

/**
 * 隱藏還沒有已發布文章的內容連結。等價於 ADR 0033 建立的規則，只是條件現在寫在
 * 導覽項目上而不是 Theme 裡——平台仍然不知道 'story' 是什麼意思。
 */
export function visibleNavigation(
  items: readonly SiteNavigationItem[], publishedContentKinds: readonly string[],
): readonly SiteNavigationItem[] {
  const published = new Set(publishedContentKinds);
  return items.filter(item => item.requiresContentKind === null || published.has(item.requiresContentKind));
}

/** 投影成 Theme 看得懂的形狀：以 menu 為鍵，各自維持 position 排序。 */
export function themeNavigation(items: readonly SiteNavigationItem[]): ThemeNavigation {
  const menus: Record<string, ThemeNavigationItem[]> = {};
  for (const item of [...items].sort(byPosition)) {
    (menus[item.menu] ??= []).push({
      label: item.label, href: item.href, ...(item.groupLabel ? { group: item.groupLabel } : {}),
    });
  }
  return menus;
}
