import { describe, expect, it } from 'vitest';
import { analyticsKeys, articleKeys, contactMessageKeys, couponKeys, createAdminQueryClient, customerKeys, deadJobKeys, erpDeliveryKeys, extensionKeys, healthKeys, inventoryQueryKeys, invoiceKeys, lifecycleDeliveryKeys, loyaltyKeys, orderKeys, productQueryKeys, promotionKeys, refundKeys, rmaKeys, shipmentKeys, shipmentOperationKeys, shippingMethodKeys } from './query';

describe('admin query foundation', () => {
  it('disables automatic retries and separates all result inputs', () => {
    const client = createAdminQueryClient();
    expect(client.getDefaultOptions()).toMatchObject({ queries: { retry: false }, mutations: { retry: false } });
    expect(productQueryKeys.list({ q: 'a', status: 'draft', limit: 20, offset: 0 })).not.toEqual(productQueryKeys.list({ q: 'b', status: 'draft', limit: 20, offset: 0 }));
    expect(inventoryQueryKeys.list({ productIds: ['a'], limit: 1 })).not.toEqual(inventoryQueryKeys.list({ productIds: ['b'], limit: 1 }));
  });

  it('keeps every result-shaping list input separate', () => {
    const variants: [string, readonly unknown[], readonly unknown[]][] = [
      ['promotion status', promotionKeys.list({ status: 'active', limit: 100, offset: 0 }), promotionKeys.list({ status: 'disabled', limit: 100, offset: 0 })],
      ['promotion limit', promotionKeys.list({ limit: 100, offset: 0 }), promotionKeys.list({ limit: 101, offset: 0 })],
      ['promotion page', promotionKeys.list({ limit: 100, offset: 0 }), promotionKeys.list({ limit: 100, offset: 1 })],
      ['coupon status', couponKeys.list({ status: 'issued', limit: 100, offset: 0 }), couponKeys.list({ status: 'void', limit: 100, offset: 0 })],
      ['coupon promotion', couponKeys.list({ promotionId: 'a', limit: 100, offset: 0 }), couponKeys.list({ promotionId: 'b', limit: 100, offset: 0 })],
      ['coupon page', couponKeys.list({ limit: 100, offset: 0 }), couponKeys.list({ limit: 101, offset: 0 })],
      ['coupon offset', couponKeys.list({ limit: 100, offset: 0 }), couponKeys.list({ limit: 100, offset: 1 })],
      ['article kind', articleKeys.list({ kind: 'news', limit: 100, offset: 0 }), articleKeys.list({ kind: 'faq', limit: 100, offset: 0 })],
      ['article status', articleKeys.list({ status: 'draft', limit: 100, offset: 0 }), articleKeys.list({ status: 'published', limit: 100, offset: 0 })],
      ['article limit', articleKeys.list({ limit: 100, offset: 0 }), articleKeys.list({ limit: 101, offset: 0 })],
      ['article page', articleKeys.list({ limit: 100, offset: 0 }), articleKeys.list({ limit: 100, offset: 1 })],
      ['order status', orderKeys.list({ status: 'paid', limit: 50, offset: 0 }), orderKeys.list({ status: 'pending', limit: 50, offset: 0 })],
      ['order page', orderKeys.list({ limit: 50, offset: 0 }), orderKeys.list({ limit: 51, offset: 0 })],
      ['order offset', orderKeys.list({ limit: 50, offset: 0 }), orderKeys.list({ limit: 50, offset: 1 })],
      ['refund order', refundKeys.list({ orderId: 'order-a', limit: 20, offset: 0 }), refundKeys.list({ orderId: 'order-b', limit: 20, offset: 0 })],
      ['refund status', refundKeys.list({ status: 'requested', limit: 20, offset: 0 }), refundKeys.list({ status: 'failed', limit: 20, offset: 0 })],
      ['refund page', refundKeys.list({ limit: 20, offset: 0 }), refundKeys.list({ limit: 20, offset: 1 })],
      ['refund limit', refundKeys.list({ limit: 20, offset: 0 }), refundKeys.list({ limit: 21, offset: 0 })],
      ['rma order', rmaKeys.list({ orderId: 'order-a', limit: 20, offset: 0 }), rmaKeys.list({ orderId: 'order-b', limit: 20, offset: 0 })],
      ['rma status', rmaKeys.list({ status: 'approved', limit: 20, offset: 0 }), rmaKeys.list({ status: 'received', limit: 20, offset: 0 })],
      ['rma page', rmaKeys.list({ limit: 20, offset: 0 }), rmaKeys.list({ limit: 20, offset: 1 })],
      ['rma limit', rmaKeys.list({ limit: 20, offset: 0 }), rmaKeys.list({ limit: 21, offset: 0 })],
      ['customer search', customerKeys.list({ q: 'a', limit: 50, offset: 0 }), customerKeys.list({ q: 'b', limit: 50, offset: 0 })],
      ['customer status', customerKeys.list({ status: 'active', limit: 50, offset: 0 }), customerKeys.list({ status: 'disabled', limit: 50, offset: 0 })],
      ['customer page', customerKeys.list({ limit: 50, offset: 0 }), customerKeys.list({ limit: 50, offset: 1 })],
      ['customer limit', customerKeys.list({ limit: 50, offset: 0 }), customerKeys.list({ limit: 51, offset: 0 })],
      ['shipping method enabled', shippingMethodKeys.list({ enabled: true, limit: 100, offset: 0 }), shippingMethodKeys.list({ enabled: false, limit: 100, offset: 0 })],
      ['shipping method page', shippingMethodKeys.list({ limit: 100, offset: 0 }), shippingMethodKeys.list({ limit: 100, offset: 1 })],
      ['shipping method limit', shippingMethodKeys.list({ limit: 100, offset: 0 }), shippingMethodKeys.list({ limit: 101, offset: 0 })],
      ['shipment operation status', shipmentOperationKeys.list({ status: 'failed', limit: 50 }), shipmentOperationKeys.list({ status: 'pending', limit: 50 })],
      ['shipment operation limit', shipmentOperationKeys.list({ limit: 50 }), shipmentOperationKeys.list({ limit: 51 })],
      ['invoice order', invoiceKeys.list({ orderId: 'order-a', limit: 50, offset: 0 }), invoiceKeys.list({ orderId: 'order-b', limit: 50, offset: 0 })],
      ['invoice status', invoiceKeys.list({ status: 'issued', limit: 50, offset: 0 }), invoiceKeys.list({ status: 'voided', limit: 50, offset: 0 })],
      ['invoice page', invoiceKeys.list({ limit: 50, offset: 0 }), invoiceKeys.list({ limit: 50, offset: 1 })],
      ['invoice limit', invoiceKeys.list({ limit: 50, offset: 0 }), invoiceKeys.list({ limit: 51, offset: 0 })],
      ['delivery order', lifecycleDeliveryKeys.list({ orderId: 'order-a', limit: 50, offset: 0 }), lifecycleDeliveryKeys.list({ orderId: 'order-b', limit: 50, offset: 0 })],
      ['delivery status', lifecycleDeliveryKeys.list({ status: 'pending', limit: 50, offset: 0 }), lifecycleDeliveryKeys.list({ status: 'sent', limit: 50, offset: 0 })],
      ['delivery page', lifecycleDeliveryKeys.list({ limit: 50, offset: 0 }), lifecycleDeliveryKeys.list({ limit: 50, offset: 1 })],
      ['delivery limit', lifecycleDeliveryKeys.list({ limit: 50, offset: 0 }), lifecycleDeliveryKeys.list({ limit: 51, offset: 0 })],
      ['ERP delivery limit', erpDeliveryKeys.list({ limit: 50 }), erpDeliveryKeys.list({ limit: 51 })],
      ['dead job page', deadJobKeys.list({ limit: 50, offset: 0 }), deadJobKeys.list({ limit: 50, offset: 1 })],
      ['dead job limit', deadJobKeys.list({ limit: 50, offset: 0 }), deadJobKeys.list({ limit: 51, offset: 0 })],
      ['contact status', contactMessageKeys.list({ status: 'new', limit: 100, offset: 0 }), contactMessageKeys.list({ status: 'handled', limit: 100, offset: 0 })],
      ['contact limit', contactMessageKeys.list({ limit: 100, offset: 0 }), contactMessageKeys.list({ limit: 101, offset: 0 })],
      ['contact offset', contactMessageKeys.list({ limit: 100, offset: 0 }), contactMessageKeys.list({ limit: 100, offset: 1 })],
      ['sales summary from', analyticsKeys.salesSummary({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.salesSummary({ from: '2026-01-02', to: '2026-01-31' })],
      ['sales summary to', analyticsKeys.salesSummary({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.salesSummary({ from: '2026-01-01', to: '2026-02-01' })],
      ['promotion performance from', analyticsKeys.promotionPerformance({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.promotionPerformance({ from: '2026-01-02', to: '2026-01-31' })],
      ['promotion performance to', analyticsKeys.promotionPerformance({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.promotionPerformance({ from: '2026-01-01', to: '2026-02-01' })],
      ['partner performance from', analyticsKeys.partnerPerformance({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.partnerPerformance({ from: '2026-01-02', to: '2026-01-31' })],
      ['partner performance to', analyticsKeys.partnerPerformance({ from: '2026-01-01', to: '2026-01-31' }), analyticsKeys.partnerPerformance({ from: '2026-01-01', to: '2026-02-01' })],
      ['product query', productQueryKeys.list({ q: 'a', limit: 20, offset: 0 }), productQueryKeys.list({ q: 'b', limit: 20, offset: 0 })],
      ['product status', productQueryKeys.list({ status: 'draft', limit: 20, offset: 0 }), productQueryKeys.list({ status: 'active', limit: 20, offset: 0 })],
      ['product limit', productQueryKeys.list({ limit: 20, offset: 0 }), productQueryKeys.list({ limit: 21, offset: 0 })],
      ['product offset', productQueryKeys.list({ limit: 20, offset: 0 }), productQueryKeys.list({ limit: 20, offset: 1 })],
      ['inventory threshold', inventoryQueryKeys.list({ productIds: [], limit: 20 }), inventoryQueryKeys.list({ productIds: ['product'], limit: 20 })],
      ['inventory product list', inventoryQueryKeys.list({ productIds: ['a'], limit: 20 }), inventoryQueryKeys.list({ productIds: ['b'], limit: 20 })],
      ['inventory limit', inventoryQueryKeys.list({ productIds: [], limit: 20 }), inventoryQueryKeys.list({ productIds: [], limit: 21 })],
    ];
    variants.forEach(([name, left, right]) => expect(left, name).not.toEqual(right));
  });

  it('keeps every id-addressed or singleton query identity explicit', () => {
    const identities: [string, readonly unknown[], readonly unknown[]][] = [
      ['loyalty customer', loyaltyKeys.customer('customer-a'), loyaltyKeys.customer('customer-b')],
      ['order detail', orderKeys.detail('order-a'), orderKeys.detail('order-b')],
      ['customer detail', customerKeys.detail('customer-a'), customerKeys.detail('customer-b')],
      ['shipment detail', shipmentKeys.detail('shipment-a'), shipmentKeys.detail('shipment-b')],
      ['shipment label', shipmentKeys.label('shipment-a'), shipmentKeys.label('shipment-b')],
      ['shipment operation detail', shipmentOperationKeys.detail('shipment-a'), shipmentOperationKeys.detail('shipment-b')],
      ['invoice detail', invoiceKeys.detail('invoice-a'), invoiceKeys.detail('invoice-b')],
      ['delivery detail', lifecycleDeliveryKeys.detail('delivery-a'), lifecycleDeliveryKeys.detail('delivery-b')],
      ['ERP detail', erpDeliveryKeys.detail('order-a'), erpDeliveryKeys.detail('order-b')],
    ];
    identities.forEach(([name, left, right]) => expect(left, name).not.toEqual(right));
    expect(loyaltyKeys.settings).not.toEqual(loyaltyKeys.tiers);
    expect(articleKeys.imageKeys).not.toEqual(articleKeys.lists);
    expect(extensionKeys.list).not.toEqual(analyticsKeys.outstandingRewards);
    expect(healthKeys.dependencies).not.toEqual(extensionKeys.list);
  });
});
