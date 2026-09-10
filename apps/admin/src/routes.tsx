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
import { ShippingPage } from './pages/ShippingPage';
import { RmaPage } from './pages/RmaPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { LoyaltyPage } from './pages/LoyaltyPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { BrandContentPage } from './pages/BrandContentPage';
import { ContactInboxPage } from './pages/ContactInboxPage';
import { OperatorsPage } from './pages/OperatorsPage';
import { ApiTokensPage } from './pages/ApiTokensPage';
import { InboxPage } from './pages/InboxPage';
import { AccountPage } from './pages/AccountPage';

/** 側欄的分組，順序即呈現順序。 */
export const NAV_SECTIONS = ['commerce', 'integrations', 'platform'] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

/** 側欄標記；回傳 null 表示這次不顯示。 */
export type NavBadge = { text: string; variant?: 'error' };

export interface RouteContext {
  /** 死信數量，供標記使用 */
  deadJobCount: number;
  /** 初次讀取失敗時顯示可辨識的側欄錯誤，不把失敗偽裝成零。 */
  deadJobError: boolean;
}

/** 看得到什麼由這個人的權限與這個 release 實際載入的模組決定。 */
export interface RouteViewer {
  /** `GET /api/v1/auth/me` 回的權限清單；`*` 是 admin 的萬用權。 */
  readonly permissions: readonly string[];
  /** 這個 release 載入了哪些模組。沒有 rma 模組就不該有退貨頁。 */
  readonly modules: readonly string[];
}

export interface RouteDefinition {
  path: Route;
  navLabel: MessageKey;
  icon: IconName;
  section: NavSection;
  title: MessageKey;
  subtitle: MessageKey;
  /** 進得了這一頁需要的權限，全部都要有。隱藏選單不是權限檢查，後端仍然會擋。 */
  permissions: readonly string[];
  /** 這一頁的資料由哪個模組提供；模組沒載入就不顯示。跨模組的頁面不填。 */
  module?: string;
  /** 頁首右側的主要動作；點擊會捲到頁面內的 targetId */
  action?: { label: MessageKey; targetId: string };
  badge?: (ctx: RouteContext) => NavBadge | null;
  render: (ctx: RouteContext) => ReactNode;
}

const ENTRIES = [
  {
    path: 'orders',
    permissions: ['order:read'],
    module: 'order',
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
    permissions: ['catalog:read'],
    module: 'catalog',
    navLabel: 'products',
    icon: 'box',
    section: 'commerce',
    title: 'productsTitle',
    subtitle: 'productsSubtitle',
    action: { label: 'createProduct', targetId: 'create-product' },
    render: () => <ProductsPage />,
  },
  {
    path: 'shipping',
    permissions: ['shipping:read'],
    module: 'shipping',
    navLabel: 'shipping',
    icon: 'box',
    section: 'commerce',
    title: 'shippingTitle',
    subtitle: 'shippingSubtitle',
    action: { label: 'createShippingMethod', targetId: 'create-shipping-method' },
    render: () => <ShippingPage />,
  },
  {
    path: 'rmas',
    permissions: ['rma:read'],
    module: 'rma',
    navLabel: 'rmas',
    icon: 'receipt',
    section: 'commerce',
    title: 'rmasTitle',
    subtitle: 'rmasSubtitle',
    render: () => <RmaPage />,
  },
  {
    path: 'invoices',
    permissions: ['invoice:read'],
    module: 'invoice',
    navLabel: 'invoices',
    icon: 'receipt',
    section: 'commerce',
    title: 'invoicesTitle',
    subtitle: 'invoicesSubtitle',
    render: () => <InvoicesPage />,
  },
  {
    path: 'promotions',
    permissions: ['promotion:read'],
    module: 'promotion',
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
    permissions: ['coupon:read'],
    module: 'coupon',
    navLabel: 'coupons',
    icon: 'box',
    section: 'commerce',
    title: 'couponsTitle',
    subtitle: 'couponsSubtitle',
    action: { label: 'createCoupon', targetId: 'create-coupon' },
    render: () => <CouponsPage />,
  },
  {
    path: 'loyalty',
    permissions: ['loyalty:write'],
    module: 'loyalty',
    navLabel: 'loyaltySettings',
    icon: 'activity',
    section: 'commerce',
    title: 'loyaltySettingsTitle',
    subtitle: 'loyaltySettingsSubtitle',
    render: () => <LoyaltyPage />,
  },
  {
    path: 'customers',
    permissions: ['customers:manage'],
    module: 'customer',
    navLabel: 'customers',
    icon: 'receipt',
    section: 'commerce',
    title: 'customersTitle',
    subtitle: 'customersSubtitle',
    render: () => <CustomersPage />,
  },
  {
    path: 'brand-content',
    permissions: ['content:read'],
    module: 'content',
    navLabel: 'brandContent',
    icon: 'file-text',
    section: 'commerce',
    title: 'brandContentTitle',
    subtitle: 'brandContentSubtitle',
    action: { label: 'createArticle', targetId: 'create-article' },
    render: () => <BrandContentPage />,
  },
  {
    path: 'contact-inbox',
    permissions: ['contact:read'],
    module: 'content',
    navLabel: 'contactInbox',
    icon: 'send',
    section: 'commerce',
    title: 'contactInboxTitle',
    subtitle: 'contactInboxSubtitle',
    render: () => <ContactInboxPage />,
  },
  {
    path: 'analytics',
    permissions: ['analytics:read'],
    module: 'order',
    navLabel: 'analytics',
    icon: 'activity',
    section: 'commerce',
    title: 'analyticsTitle',
    subtitle: 'analyticsSubtitle',
    render: () => <AnalyticsPage />,
  },
  {
    path: 'notifications',
    permissions: ['notification:read'],
    module: 'notification',
    navLabel: 'notifications',
    icon: 'activity',
    section: 'integrations',
    title: 'notificationsTitle',
    subtitle: 'notificationsSubtitle',
    render: () => <NotificationsPage />,
  },
  {
    path: 'erp',
    permissions: ['erp:read'],
    navLabel: 'erpQueue',
    icon: 'database',
    section: 'integrations',
    title: 'erpTitle',
    subtitle: 'erpSubtitle',
    render: () => <ErpPage />,
  },
  {
    path: 'dlq',
    permissions: ['jobs:read'],
    navLabel: 'dlq',
    icon: 'alert',
    section: 'integrations',
    title: 'dlqTitle',
    subtitle: 'dlqSubtitle',
    badge: ({ deadJobCount, deadJobError }: RouteContext): NavBadge | null =>
      (deadJobError ? { text: '!', variant: 'error' } : deadJobCount > 0 ? { text: String(deadJobCount), variant: 'error' } : null),
    render: () => <DlqPage />,
  },
  {
    path: 'system',
    permissions: ['jobs:read'],
    navLabel: 'systemHealth',
    icon: 'activity',
    section: 'integrations',
    title: 'systemTitle',
    subtitle: 'systemSubtitle',
    render: () => <SystemPage />,
  },
  {
    path: 'operators',
    permissions: ['users:read'],
    module: 'platform-identity',
    navLabel: 'operators',
    icon: 'user',
    section: 'platform',
    title: 'operatorsTitle',
    subtitle: 'operatorsSubtitle',
    action: { label: 'createOperator', targetId: 'create-operator' },
    render: () => <OperatorsPage />,
  },
  {
    path: 'api-tokens',
    permissions: ['tokens:read'],
    module: 'platform-identity',
    navLabel: 'apiTokens',
    icon: 'shield',
    section: 'platform',
    title: 'apiTokensTitle',
    subtitle: 'apiTokensSubtitle',
    action: { label: 'issueApiToken', targetId: 'issue-api-token' },
    render: () => <ApiTokensPage />,
  },
  {
    path: 'inbox',
    permissions: ['notifications:inbox'],
    module: 'platform-notifications',
    navLabel: 'inbox',
    icon: 'send',
    section: 'platform',
    title: 'inboxTitle',
    subtitle: 'inboxSubtitle',
    render: () => <InboxPage />,
  },
  {
    // 自己的帳號：任何登得進來的人都做得到，所以不需要任何權限。
    path: 'account',
    permissions: [],
    navLabel: 'account',
    icon: 'user',
    section: 'platform',
    title: 'accountTitle',
    subtitle: 'accountSubtitle',
    render: () => <AccountPage />,
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

/**
 * 這個人在側欄與命令面板看得到哪幾列。權限與模組都要通過——
 * 一個沒有 rma 模組的 release，就算角色帶著 `rma:read` 也不該有退貨頁。
 */
export function visibleRoutes(viewer: RouteViewer): readonly RouteDefinition[] {
  const permissions = new Set(viewer.permissions);
  const modules = new Set(viewer.modules);
  const holds = (key: string) => permissions.has('*') || permissions.has(key);
  return ROUTE_TABLE.filter((entry) =>
    entry.permissions.every(holds) && (entry.module === undefined || modules.has(entry.module)));
}

/** 起始頁。預設路由被藏起來時退到第一列看得到的，而不是渲染一頁按不動的東西。 */
export function firstVisibleRoute(routes: readonly RouteDefinition[]): Route | null {
  if (routes.some((entry) => entry.path === DEFAULT_ROUTE)) return DEFAULT_ROUTE;
  return routes[0]?.path ?? null;
}
