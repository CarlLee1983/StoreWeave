import { describe, expect, it } from 'vitest';
import { customerInvalidationKeys, type CustomerOperation } from './customer-operations';
import { orderInvalidationKeys, type OrderOperation } from './order-operations';
import { rmaInvalidationKeys, type RmaOperation } from './rma-operations';
import { shippingInvalidationKeys, type ShippingOperation } from './shipping-operations';
import { analyticsKeys, couponKeys, customerKeys, deadJobKeys, erpDeliveryKeys, inventoryQueryKeys, invoiceKeys, lifecycleDeliveryKeys, loyaltyKeys, orderKeys, refundKeys, rmaKeys, shipmentKeys, shipmentOperationKeys, shippingMethodKeys } from './query';
import type { Order, Shipment } from './api';

const key = 'key';
const shipment = { id: 'shipment', provider: 'ecpay-logistics' } as Shipment;
const order = { id: 'order', status: 'paid', number: 'SW-1' } as Order;

describe('Ticket 88 concrete invalidation maps', () => {
  it('keeps customer mutations at their proven projections', () => {
    const status: CustomerOperation = { area: 'customer', scope: 'customer-profile:c', kind: 'status', customerId: 'c', request: { status: 'disabled' }, draft: { status: 'disabled' }, idempotencyKey: key };
    const birthday: CustomerOperation = { area: 'customer', scope: 'customer-profile:c', kind: 'birthday', customerId: 'c', request: { birthday: '2000-01-01', reason: 'correction' }, draft: { birthday: '2000-01-01', reason: 'correction' }, idempotencyKey: key };
    const rewards: CustomerOperation = { area: 'customer', scope: 'customer-rewards:c', kind: 'rewards', customerId: 'c', request: { amountCents: 1, reason: 'r' }, draft: { amount: '001', reason: 'r', currency: 'TWD' }, idempotencyKey: key };
    const points: CustomerOperation = { area: 'customer', scope: 'customer-tier-points:c', kind: 'tier-points', customerId: 'c', request: { points: 1, reason: 'r' }, draft: { points: '001', reason: 'r' }, idempotencyKey: key };
    expect(customerInvalidationKeys(status)).toEqual([customerKeys.lists, customerKeys.detail('c')]);
    expect(customerInvalidationKeys(birthday)).toEqual([customerKeys.lists, customerKeys.detail('c')]);
    expect(customerInvalidationKeys(rewards)).toEqual([loyaltyKeys.customer('c'), analyticsKeys.outstandingRewards]);
    expect(customerInvalidationKeys(points)).toEqual([loyaltyKeys.customer('c')]);
  });

  it('uses exact shipment and ECPay effects only when proven', () => {
    const method: ShippingOperation = { area: 'shipping', scope: 'shipping-method:create', kind: 'create-method', request: { code: 'method', name: 'Method', provider: 'manual', type: 'home', destinationKind: 'taiwan_home', feeCents: 0, enabled: true }, draft: { code: 'method', name: 'Method', provider: 'manual', type: 'home', destinationKind: 'taiwan_home', feeCents: '0', freeShippingThresholdCents: '', enabled: true }, idempotencyKey: key };
    const methodUpdate: ShippingOperation = { area: 'shipping', scope: 'shipping-method:method', kind: 'update-method', methodId: 'method', request: { name: 'Method', provider: 'manual', type: 'home', destinationKind: 'taiwan_home', feeCents: 0, enabled: true }, draft: { name: 'Method', provider: 'manual', type: 'home', destinationKind: 'taiwan_home', feeCents: '0', freeShippingThresholdCents: '', enabled: true }, idempotencyKey: key };
    const create: ShippingOperation = { area: 'shipping', scope: 'order:o', kind: 'create-shipment', orderId: 'o', request: { orderId: 'o' }, draft: { orderId: 'o' }, idempotencyKey: key };
    const completed: ShippingOperation = { area: 'shipping', scope: 'shipment:shipment', kind: 'advance-shipment', shipmentId: 'shipment', request: { status: 'completed' }, draft: { status: 'completed' }, idempotencyKey: key };
    const shipped: ShippingOperation = { ...completed, request: { status: 'shipped' }, draft: { status: 'shipped' } };
    const arrived: ShippingOperation = { ...completed, request: { status: 'arrived' }, draft: { status: 'arrived' } };
    const retry: ShippingOperation = { area: 'shipping', scope: 'shipment:shipment', kind: 'retry-ecpay', shipmentId: 'shipment', request: { shipmentId: 'shipment' }, draft: {}, idempotencyKey: key };
    expect(shippingInvalidationKeys({} as Shipment, method)).toEqual([shippingMethodKeys.lists]);
    expect(shippingInvalidationKeys({} as Shipment, methodUpdate)).toEqual([shippingMethodKeys.lists]);
    expect(shippingInvalidationKeys(shipment, create)).toEqual([shipmentKeys.detail('shipment'), shipmentOperationKeys.lists, shipmentOperationKeys.detail('shipment')]);
    expect(shippingInvalidationKeys({ id: 'manual-shipment', provider: 'manual' } as Shipment, create)).toEqual([shipmentKeys.detail('manual-shipment')]);
    expect(shippingInvalidationKeys(shipment, completed)).toEqual([shipmentKeys.detail('shipment')]);
    expect(shippingInvalidationKeys(shipment, shipped)).toEqual([shipmentKeys.detail('shipment'), lifecycleDeliveryKeys.lists]);
    expect(shippingInvalidationKeys(shipment, arrived)).toEqual([shipmentKeys.detail('shipment'), lifecycleDeliveryKeys.lists]);
    expect(shippingInvalidationKeys(shipment, retry)).toEqual([shipmentOperationKeys.lists, shipmentOperationKeys.detail('shipment'), shipmentKeys.detail('shipment'), deadJobKeys.lists]);
  });

  it('keeps order and RMA conditional effects concrete', () => {
    const pay: OrderOperation = { area: 'order', scope: 'order:order', kind: 'pay', orderId: 'order', request: {}, draft: {}, idempotencyKey: key };
    const cancel: OrderOperation = { area: 'order', scope: 'order:order', kind: 'cancel', orderId: 'order', request: { reason: 'r' }, draft: { reason: 'r' }, idempotencyKey: key };
    const refund: OrderOperation = { area: 'order', scope: 'order:order', kind: 'refund', orderId: 'order', request: { reason: 'r' }, draft: { reason: 'r' }, idempotencyKey: key };
    const retry: OrderOperation = { area: 'order', scope: 'refund:r', kind: 'retry-refund', refundId: 'r', request: {}, draft: {}, idempotencyKey: key };
    expect(orderInvalidationKeys({ ...order, status: 'payment_processing' }, pay)).toEqual([orderKeys.lists, orderKeys.detail('order'), customerKeys.details, analyticsKeys.salesSummaries]);
    expect(orderInvalidationKeys(order, pay)).toEqual([orderKeys.lists, orderKeys.detail('order'), customerKeys.details, analyticsKeys.salesSummaries, inventoryQueryKeys.lists, loyaltyKeys.customers, analyticsKeys.outstandingRewards, invoiceKeys.lists, lifecycleDeliveryKeys.lists, erpDeliveryKeys.lists]);
    expect(orderInvalidationKeys(order, cancel)).toEqual([orderKeys.lists, orderKeys.detail('order'), customerKeys.details, inventoryQueryKeys.lists, couponKeys.lists, loyaltyKeys.customers, analyticsKeys.outstandingRewards, analyticsKeys.salesSummaries, analyticsKeys.promotionPerformances, analyticsKeys.partnerPerformances]);
    expect(orderInvalidationKeys(order, refund)).toEqual([refundKeys.lists]);
    expect(orderInvalidationKeys(order, retry)).toEqual([refundKeys.lists, rmaKeys.lists]);
    const receive: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'receive', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: { lines: [{ rmaLineId: 'line', disposition: 'restock' }] }, draft: { lines: [{ rmaLineId: 'line', disposition: 'restock', discardReason: '' }] }, idempotencyKey: key };
    const discard: RmaOperation = { ...receive, request: { lines: [{ rmaLineId: 'line', disposition: 'discard' }] }, draft: { lines: [{ rmaLineId: 'line', disposition: 'discard', discardReason: 'damage' }] } };
    const rmaRefund: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'refund', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: {}, draft: { reason: '' }, idempotencyKey: key };
    const approve: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'approve', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: {}, draft: { note: '' }, idempotencyKey: key };
    const information: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'information', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: { reason: 'need detail' }, draft: { reason: 'need detail' }, idempotencyKey: key };
    const reject: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'reject', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: { reason: 'out of policy' }, draft: { reason: 'out of policy' }, idempotencyKey: key };
    const retryRmaRefund: RmaOperation = { area: 'rma', scope: 'rma:r', kind: 'retry-refund', rmaId: 'r', resource: { orderId: 'order', lines: [] }, request: { refundId: 'refund' }, draft: {}, idempotencyKey: key };
    expect(rmaInvalidationKeys(approve)).toEqual([rmaKeys.lists]);
    expect(rmaInvalidationKeys(information)).toEqual([rmaKeys.lists]);
    expect(rmaInvalidationKeys(reject)).toEqual([rmaKeys.lists]);
    expect(rmaInvalidationKeys(receive)).toEqual([rmaKeys.lists, inventoryQueryKeys.lists]);
    expect(rmaInvalidationKeys(discard)).toEqual([rmaKeys.lists]);
    expect(rmaInvalidationKeys(rmaRefund)).toEqual([rmaKeys.lists, refundKeys.lists]);
    expect(rmaInvalidationKeys(retryRmaRefund)).toEqual([rmaKeys.lists, refundKeys.lists]);
  });
});
