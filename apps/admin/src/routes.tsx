// 後台的路由表：頁面、導覽、標題與主要動作全部來自這一份資料。
// 新增一個頁面 = 加一列。路由仍然是編譯期已知的，不做執行期註冊。
import type { ReactNode } from 'react';
import type { MessageKey } from './i18n';
import type { IconName } from './components/Icon';
import { ProductsPage } from './pages/ProductsPage';
import { OrdersPage } from './pages/OrdersPage';
import { PromotionsPage } from './pages/PromotionsPage';
import { CouponsPage } from './pages/CouponsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { CustomersPage } from './pages/CustomersPage';
import { ErpPage } from './pages/ErpPage';
import { SystemPage } from './pages/SystemPage';
import { DlqPage } from './pages/DlqPage';

/** 側欄的分組，順序即呈現順序。 */
export const NAV_SECTIONS = ['commerce', 'integrations'] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

/** 側欄標記；回傳 null 表示這次不顯示。 */
export type NavBadge = { text: string; variant?: 'error' };

export interface RouteContext {
  /** 死信數量，供標記使用 */
  deadJobCount: number;
  /** 頁面回報資料有變動，讓外殼重新整理側欄標記 */
  onDeadJobsChanged: () => void;
}

export interface RouteDefinition {
  path: Route;
  navLabel: MessageKey;
  icon: IconName;
  section: NavSection;
  title: MessageKey;
  subtitle: MessageKey;
  /** 頁首右側的主要動作；點擊會捲到頁面內的 targetId */
  action?: { label: MessageKey; targetId: string };
  badge?: (ctx: RouteContext) => NavBadge | null;
  render: (ctx: RouteContext) => ReactNode;
}

const ENTRIES = [
  {
    path: 'orders',
    navLabel: 'orders',
    icon: 'receipt',
    section: 'commerce',
    title: 'ordersTitle',
    subtitle: 'ordersSubtitle',
    badge: (): NavBadge => ({ text: 'LIVE' }),
    render: () => <OrdersPage />,
  },
  {
    path: 'products',
    navLabel: 'products',
    icon: 'box',
    section: 'commerce',
    title: 'productsTitle',
    subtitle: 'productsSubtitle',
    action: { label: 'createProduct', targetId: 'create-product' },
    render: () => <ProductsPage />,
  },
  {
    path: 'promotions',
    navLabel: 'promotions',
    icon: 'box',
    section: 'commerce',
    title: 'promotionsTitle',
    subtitle: 'promotionsSubtitle',
    action: { label: 'createPromotion', targetId: 'create-promotion' },
    render: () => <PromotionsPage />,
  },
  {
    path: 'coupons',
    navLabel: 'coupons',
    icon: 'box',
    section: 'commerce',
    title: 'couponsTitle',
    subtitle: 'couponsSubtitle',
    action: { label: 'createCoupon', targetId: 'create-coupon' },
    render: () => <CouponsPage />,
  },
  {
    path: 'customers',
    navLabel: 'customers',
    icon: 'receipt',
    section: 'commerce',
    title: 'customersTitle',
    subtitle: 'customersSubtitle',
    render: () => <CustomersPage />,
  },
  {
    path: 'analytics',
    navLabel: 'analytics',
    icon: 'activity',
    section: 'commerce',
    title: 'analyticsTitle',
    subtitle: 'analyticsSubtitle',
    render: () => <AnalyticsPage />,
  },
  {
    path: 'erp',
    navLabel: 'erpQueue',
    icon: 'database',
    section: 'integrations',
    title: 'erpTitle',
    subtitle: 'erpSubtitle',
    render: () => <ErpPage />,
  },
  {
    path: 'dlq',
    navLabel: 'dlq',
    icon: 'alert',
    section: 'integrations',
    title: 'dlqTitle',
    subtitle: 'dlqSubtitle',
    badge: ({ deadJobCount }: RouteContext): NavBadge | null =>
      (deadJobCount > 0 ? { text: String(deadJobCount), variant: 'error' } : null),
    render: ({ onDeadJobsChanged }: RouteContext) => <DlqPage onChanged={onDeadJobsChanged} />,
  },
  {
    path: 'system',
    navLabel: 'systemHealth',
    icon: 'activity',
    section: 'integrations',
    title: 'systemTitle',
    subtitle: 'systemSubtitle',
    render: () => <SystemPage />,
  },
] as const;

/** 路由名稱由表格推導，不另外維護一份聯集。 */
export type Route = (typeof ENTRIES)[number]['path'];

export const ROUTE_TABLE: readonly RouteDefinition[] = ENTRIES;

export const DEFAULT_ROUTE: Route = 'products';

export function routeDefinition(route: Route): RouteDefinition {
  const found = ROUTE_TABLE.find((entry) => entry.path === route);
  if (!found) throw new Error(`未知的路由：${route}`);
  return found;
}

export function isRoute(value: string): value is Route {
  return ROUTE_TABLE.some((entry) => entry.path === value);
}
