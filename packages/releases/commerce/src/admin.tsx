import React, { type ReactNode } from 'react';
import type { MessageKey } from '../../../../apps/admin/src/i18n';
import type { IconName } from '../../../../apps/admin/src/components/Icon';
import { ProductsPage } from '../../../../apps/admin/src/pages/ProductsPage';
import { OrdersPage } from '../../../../apps/admin/src/pages/OrdersPage';
import { PromotionsPage } from '../../../../apps/admin/src/pages/PromotionsPage';
import { CouponsPage } from '../../../../apps/admin/src/pages/CouponsPage';
import { AnalyticsPage } from '../../../../apps/admin/src/pages/AnalyticsPage';
import { CustomersPage } from '../../../../apps/admin/src/pages/CustomersPage';
import { ErpPage } from '../../../../apps/admin/src/pages/ErpPage';
import { SystemPage } from '../../../../apps/admin/src/pages/SystemPage';
import { DlqPage } from '../../../../apps/admin/src/pages/DlqPage';
import { ShippingPage } from '../../../../apps/admin/src/pages/ShippingPage';
import { RmaPage } from '../../../../apps/admin/src/pages/RmaPage';
import { InvoicesPage } from '../../../../apps/admin/src/pages/InvoicesPage';
import { LoyaltyPage } from '../../../../apps/admin/src/pages/LoyaltyPage';
import { NotificationsPage } from '../../../../apps/admin/src/pages/NotificationsPage';
import { BrandContentPage } from '../../../../apps/admin/src/pages/BrandContentPage';
import { ContactInboxPage } from '../../../../apps/admin/src/pages/ContactInboxPage';
import { OperatorsPage } from '../../../../apps/admin/src/pages/OperatorsPage';
import { ApiTokensPage } from '../../../../apps/admin/src/pages/ApiTokensPage';
import { InboxPage } from '../../../../apps/admin/src/pages/InboxPage';
import { AccountPage } from '../../../../apps/admin/src/pages/AccountPage';
import { MediaLibraryPage } from '../../../../apps/admin/src/pages/MediaLibraryPage';
import { assembleAdminProjection, resolveAdminProjection, type AdminNavBadge, type AdminProjectionAssemblyInput, type AdminProjectionFactory, type AdminRouteDefinition } from '@storeweave/release/admin';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';

export type NavBadge = AdminNavBadge;

export interface RouteContext {
  /** 死信數量，供標記使用 */
  deadJobCount: number;
  /** 初次讀取失敗時顯示可辨識的側欄錯誤，不把失敗偽裝成零。 */
  deadJobError: boolean;
}


type AdminEntry = AdminRouteDefinition<string, MessageKey, IconName, string, RouteContext, ReactNode>;

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
    path: 'media',
    permissions: ['media:read'],
    module: 'platform-media',
    navLabel: 'mediaLibrary',
    icon: 'upload',
    section: 'platform',
    title: 'mediaLibraryTitle',
    subtitle: 'mediaLibrarySubtitle',
    render: () => <MediaLibraryPage />,
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
] as const satisfies readonly AdminEntry[];

const commerceAdminContribution = { key: 'commerce.admin.routes.v1', routes: ENTRIES } as const;

export const adminProjectionReleaseDefinition = commerceReleaseDefinition;
export const adminProjectionAssembly = {
  requiredContributionKeys: [commerceAdminContribution.key],
  contributions: [commerceAdminContribution],
  defaultRoute: 'products',
} as const satisfies AdminProjectionAssemblyInput<AdminEntry>;

function assembleCommerceAdminProjection() {
  return assembleAdminProjection(adminProjectionAssembly);
}

export type Route = (typeof ENTRIES)[number]['path'];
export type NavSection = (typeof ENTRIES)[number]['section'];
export type RouteDefinition = (typeof ENTRIES)[number];
export type CommerceAdminProjection = ReturnType<typeof assembleCommerceAdminProjection>;

export const adminProjectionFactory: AdminProjectionFactory<CommerceAdminProjection> = {
  target: 'admin',
  key: COMMERCE_TARGET_KEYS.admin,
  resolve: assembleCommerceAdminProjection,
};

export function resolveCommerceAdminProjection(): CommerceAdminProjection;
export function resolveCommerceAdminProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<AdminProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceAdminProjection<Contribution>(
  definition: unknown = commerceReleaseDefinition,
  factory: CommerceProjectionFactoryInput<AdminProjectionFactory<Contribution>> = adminProjectionFactory as AdminProjectionFactory<Contribution>,
): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveAdminProjection(validated, requireCommerceProjectionFactory('admin', COMMERCE_TARGET_KEYS.admin, commerceFactoryList(factory)));
}

export const adminProjection = resolveCommerceAdminProjection();
export const ROUTE_TABLE = adminProjection.routes;
export const NAV_SECTIONS = adminProjection.navSections;
export const DEFAULT_ROUTE = adminProjection.defaultRoute;
