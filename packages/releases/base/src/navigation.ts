import { navigationItem, type SiteNavigationItem } from '@storeweave/site';

/** Base navigation contains no Commerce routes; unpublished content stays hidden. */
export const BASE_NAVIGATION: readonly SiteNavigationItem[] = [
  navigationItem({ menu: 'primary', label: '首頁', href: '/', position: 0 }),
  navigationItem({ menu: 'primary', label: '品牌故事', href: '/story', position: 10, requiresContentKind: 'story' }),
  navigationItem({ menu: 'primary', label: '生活誌', href: '/journal', position: 20, requiresContentKind: 'journal' }),
  navigationItem({ menu: 'primary', label: '最新消息', href: '/news', position: 30, requiresContentKind: 'news' }),
  navigationItem({ menu: 'primary', label: '常見問題', href: '/faq', position: 40, requiresContentKind: 'faq' }),
  navigationItem({ menu: 'primary', label: '聯絡我們', href: '/contact', position: 50 }),
];
