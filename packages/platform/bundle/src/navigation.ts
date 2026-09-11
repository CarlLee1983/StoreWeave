import { navigationItem, type SiteNavigationItem } from '@storeweave/site';

/**
 * Commerce release 的預設導覽。資料庫空著的時候用它渲染；店家改過某一組之後，
 * 那一組換成資料庫的內容（ADR 0046）。這份清單原本硬編碼在
 * `packages/themes/default/src/layout.ts`——它是「這個 release 有哪些頁面」的結果，
 * 不是外觀的一部分，所以搬到組裝這裡。
 *
 * 帶 `requiresContentKind` 的項目要等該種內容有已發布的文章才出現（ADR 0033）。
 */
export const COMMERCE_NAVIGATION: readonly SiteNavigationItem[] = [
  navigationItem({ menu: 'primary', label: '首頁', href: '/', position: 0 }),
  navigationItem({ menu: 'primary', label: '商品型錄', href: '/catalog', position: 10 }),
  navigationItem({ menu: 'primary', label: '品牌故事', href: '/story', position: 20, requiresContentKind: 'story' }),
  navigationItem({ menu: 'primary', label: '生活誌', href: '/journal', position: 30, requiresContentKind: 'journal' }),
  navigationItem({ menu: 'primary', label: '最新消息', href: '/news', position: 40, requiresContentKind: 'news' }),
  navigationItem({ menu: 'primary', label: '常見問題', href: '/faq', position: 50, requiresContentKind: 'faq' }),
  navigationItem({ menu: 'primary', label: '聯絡我們', href: '/contact', position: 60 }),
  navigationItem({ menu: 'primary', label: '購物車', href: '/cart', position: 70 }),

  navigationItem({ menu: 'footer', groupLabel: '商品', label: '瀏覽商品', href: '/catalog', position: 0 }),
  navigationItem({ menu: 'footer', groupLabel: '商品', label: '購物車', href: '/cart', position: 10 }),
  navigationItem({ menu: 'footer', groupLabel: '帳戶', label: '會員購物金', href: '/account/rewards', position: 20 }),
  navigationItem({ menu: 'footer', groupLabel: '帳戶', label: '訂單查詢', href: '/account/orders', position: 30 }),
  navigationItem({ menu: 'footer', groupLabel: '認識我們', label: '品牌故事', href: '/story', position: 40, requiresContentKind: 'story' }),
  navigationItem({ menu: 'footer', groupLabel: '認識我們', label: '生活誌', href: '/journal', position: 50, requiresContentKind: 'journal' }),
  navigationItem({ menu: 'footer', groupLabel: '認識我們', label: '最新消息', href: '/news', position: 60, requiresContentKind: 'news' }),
  navigationItem({ menu: 'footer', groupLabel: '認識我們', label: '常見問題', href: '/faq', position: 70, requiresContentKind: 'faq' }),
  navigationItem({ menu: 'footer', groupLabel: '聯絡', label: '寫訊息給我們', href: '/contact', position: 80 }),
];

/**
 * Base release 的預設導覽。內容模組是網站能力，不需要 Commerce；尚未發布
 * 對應內容時，requiresContentKind 會把入口隱藏起來。
 */
export const BASE_NAVIGATION: readonly SiteNavigationItem[] = [
  navigationItem({ menu: 'primary', label: '首頁', href: '/', position: 0 }),
  navigationItem({ menu: 'primary', label: '品牌故事', href: '/story', position: 10, requiresContentKind: 'story' }),
  navigationItem({ menu: 'primary', label: '生活誌', href: '/journal', position: 20, requiresContentKind: 'journal' }),
  navigationItem({ menu: 'primary', label: '最新消息', href: '/news', position: 30, requiresContentKind: 'news' }),
  navigationItem({ menu: 'primary', label: '常見問題', href: '/faq', position: 40, requiresContentKind: 'faq' }),
  navigationItem({ menu: 'primary', label: '聯絡我們', href: '/contact', position: 50 }),
];
