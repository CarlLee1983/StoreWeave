import { QueryClient } from '@tanstack/react-query';

export function createAdminQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export const productQueryKeys = {
  lists: ['products', 'list'] as const,
  list: (input: { q?: string; status?: string; limit: number; offset: number }) =>
    [...productQueryKeys.lists, input] as const,
};

export const inventoryQueryKeys = {
  lists: ['inventory', 'list'] as const,
  list: (input: { productIds: string[]; limit: number }) =>
    [...inventoryQueryKeys.lists, input] as const,
};

export const productCommandKey = ['products', 'command'] as const;

// List inputs deliberately retain limit/offset: pagination is data, not a view-only concern.
export const promotionKeys = { all: ['promotions'] as const, lists: ['promotions', 'list'] as const, list: (input: { status?: string; limit: number; offset: number }) => [...promotionKeys.lists, input] as const };
export const couponKeys = { all: ['coupons'] as const, lists: ['coupons', 'list'] as const, list: (input: { status?: string; promotionId?: string; limit: number; offset: number }) => [...couponKeys.lists, input] as const };
export const loyaltyKeys = { all: ['loyalty'] as const, settings: ['loyalty', 'settings'] as const, tiers: ['loyalty', 'tiers'] as const, customers: ['loyalty', 'customer'] as const, customer: (id: string) => [...loyaltyKeys.customers, id] as const };
export const articleKeys = { all: ['articles'] as const, lists: ['articles', 'list'] as const, list: (input: { kind?: string; status?: string; limit: number; offset: number }) => [...articleKeys.lists, input] as const, imageKeys: ['articles', 'image-keys'] as const };
export const orderKeys = { all: ['orders'] as const, lists: ['orders', 'list'] as const, list: (input: { status?: string; limit: number; offset: number }) => [...orderKeys.lists, input] as const, details: ['orders', 'detail'] as const, detail: (id: string) => [...orderKeys.details, id] as const };
export const refundKeys = { all: ['refunds'] as const, lists: ['refunds', 'list'] as const, list: (input: { orderId?: string; status?: string; limit: number; offset: number }) => [...refundKeys.lists, input] as const };
export const rmaKeys = { all: ['rmas'] as const, lists: ['rmas', 'list'] as const, list: (input: { orderId?: string; status?: string; limit: number; offset: number }) => [...rmaKeys.lists, input] as const };
export const customerKeys = { all: ['customers'] as const, lists: ['customers', 'list'] as const, list: (input: { q?: string; status?: string; limit: number; offset: number }) => [...customerKeys.lists, input] as const, details: ['customers', 'detail'] as const, detail: (id: string) => [...customerKeys.details, id] as const };
export const shippingMethodKeys = { all: ['shipping-methods'] as const, lists: ['shipping-methods', 'list'] as const, list: (input: { enabled?: boolean; limit: number; offset: number }) => [...shippingMethodKeys.lists, input] as const };
export const shipmentKeys = { all: ['shipments'] as const, details: ['shipments', 'detail'] as const, detail: (id: string) => [...shipmentKeys.details, id] as const, labels: ['shipments', 'label'] as const, label: (id: string) => [...shipmentKeys.labels, id] as const };
export const shipmentOperationKeys = { all: ['shipment-operations'] as const, lists: ['shipment-operations', 'list'] as const, list: (input: { status?: string; limit: number }) => [...shipmentOperationKeys.lists, input] as const, details: ['shipment-operations', 'detail'] as const, detail: (id: string) => [...shipmentOperationKeys.details, id] as const };
export const extensionKeys = { all: ['extensions'] as const, list: ['extensions', 'list'] as const };
export const analyticsKeys = {
  all: ['analytics'] as const,
  salesSummaries: ['analytics', 'sales-summary'] as const,
  salesSummary: (input: { from: string; to: string }) => [...analyticsKeys.salesSummaries, input] as const,
  promotionPerformances: ['analytics', 'promotion-performance'] as const,
  promotionPerformance: (input: { from: string; to: string }) => [...analyticsKeys.promotionPerformances, input] as const,
  partnerPerformances: ['analytics', 'partner-performance'] as const,
  partnerPerformance: (input: { from: string; to: string }) => [...analyticsKeys.partnerPerformances, input] as const,
  outstandingRewards: ['analytics', 'outstanding-rewards'] as const,
};
export const invoiceKeys = { all: ['invoices'] as const, lists: ['invoices', 'list'] as const, list: (input: { orderId?: string; status?: string; limit: number; offset: number }) => [...invoiceKeys.lists, input] as const, details: ['invoices', 'detail'] as const, detail: (id: string) => [...invoiceKeys.details, id] as const };
export const lifecycleDeliveryKeys = { all: ['lifecycle-deliveries'] as const, lists: ['lifecycle-deliveries', 'list'] as const, list: (input: { orderId?: string; status?: string; limit: number; offset: number }) => [...lifecycleDeliveryKeys.lists, input] as const, details: ['lifecycle-deliveries', 'detail'] as const, detail: (id: string) => [...lifecycleDeliveryKeys.details, id] as const };
export const erpDeliveryKeys = { all: ['erp-deliveries'] as const, lists: ['erp-deliveries', 'list'] as const, list: (input: { limit: number }) => [...erpDeliveryKeys.lists, input] as const, details: ['erp-deliveries', 'detail'] as const, detail: (id: string) => [...erpDeliveryKeys.details, id] as const };
export const deadJobKeys = { all: ['dead-jobs'] as const, lists: ['dead-jobs', 'list'] as const, list: (input: { limit: number; offset: number }) => [...deadJobKeys.lists, input] as const };
export const healthKeys = { all: ['health'] as const, dependencies: ['health', 'dependencies'] as const };
export const contactMessageKeys = { all: ['contact-messages'] as const, lists: ['contact-messages', 'list'] as const, list: (input: { status?: string; limit: number; offset: number }) => [...contactMessageKeys.lists, input] as const };

// B13 片4／片5：平台分組的頁面。
export const operatorKeys = { all: ['operators'] as const, lists: ['operators', 'list'] as const, list: (input: { limit: number; offset: number }) => [...operatorKeys.lists, input] as const };
export const apiTokenKeys = { all: ['api-tokens'] as const, list: ['api-tokens', 'list'] as const };
export const inboxKeys = { all: ['inbox'] as const, lists: ['inbox', 'list'] as const, list: (input: { limit: number; offset: number; unreadOnly: boolean }) => [...inboxKeys.lists, input] as const };
export const accountKeys = { all: ['account'] as const, mfa: ['account', 'mfa'] as const };
