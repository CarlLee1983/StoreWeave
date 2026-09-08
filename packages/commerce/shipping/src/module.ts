import packageJson from '../package.json';
import { type BoundModuleCapability, defineModule } from '@storeweave/kernel';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import {
  advanceShipmentStageCommand, advanceShipmentStageHandler, createShipmentCommand, createShipmentHandler,
  beginPickupSelectionCommand, beginPickupSelectionHandler, completePickupSelectionCommand, completePickupSelectionHandler,
  createShippingMethodCommand, createShippingMethodHandler, recordProviderCallbackCommand, recordProviderCallbackHandler, recordProviderShipmentCommand, recordProviderShipmentHandler,
  recordProviderStatusCommand, recordProviderStatusHandler,
  updateShippingMethodCommand, updateShippingMethodHandler,
} from './commands';
import { shippingEvents } from './events';
import { shippingMigrations } from './migrations';
import {
  checkoutShippingQuoteHandler, checkoutShippingQuoteQuery,
  getShipmentForOrderHandler, getShipmentForOrderQuery, getShipmentHandler, getShipmentQuery, getShippingMethodHandler, getShippingMethodQuery,
  getProviderShipmentRequestHandler, getProviderShipmentRequestQuery,
  getProviderShipmentStatusRequestHandler, getProviderShipmentStatusRequestQuery,
  getShipmentLabelInfoHandler, getShipmentLabelInfoQuery,
  listShippingMethodsHandler, listShippingMethodsQuery,
  getPickupSelectionViewHandler, getPickupSelectionViewQuery,
} from './queries';
import type { ShipmentOrderLookup, ShipmentRefundGuard } from './service';

/** Shipping is assembled with a narrow order read port, not direct order-table access. */
export function createShippingModule(ordersBinding: BoundModuleCapability<ShipmentOrderLookup>, providers: ProviderRegistry, refundsBinding?: BoundModuleCapability<ShipmentRefundGuard>) {
  const orders = ordersBinding.value;
  const refunds = refundsBinding?.value;

  return defineModule({
  name: 'shipping',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'cart', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
  ] },
  capabilities: {
    required: [
      { from: 'order', capability: 'commerce.order.shipment-lookup', versionRange: '^0.1.0' },
    ],
    optional: [
      { from: 'refund', capability: 'commerce.refund.shipment-guard', versionRange: '^0.1.0' },
    ],
    bound: [ordersBinding, ...(refundsBinding ? [refundsBinding] : [])],
    provides: ['commerce.shipping.shipment-lookup', 'commerce.shipping.return-lookup'] },
  data: { owns: ['shipping_methods', 'shipping_shipments', 'shipping_pickup_selections'] },
  migrations: shippingMigrations,
  events: shippingEvents,
  permissions: [
    { key: 'shipping:read', description: '讀取運送方式', owner: 'shipping' },
    // Shipment ids are operational data, not storefront-discoverable resources.
    { key: 'shipping:shipment-read', description: '讀取物流單', owner: 'shipping' },
    { key: 'shipping:write', description: '維護運送方式與物流單', owner: 'shipping' },
    // Carrier extensions receive a narrow PII-bearing request projection and
    // can only write their own completed provider result.
    { key: 'shipping:provider-read', description: '讀取 carrier 建單快照', owner: 'shipping' },
    { key: 'shipping:provider-write', description: '記錄 carrier 建單結果', owner: 'shipping' },
    { key: 'shipping:label-read', description: '讀取物流標籤列印參照', owner: 'shipping' },
  ],
  commands: [
    { descriptor: createShippingMethodCommand, handler: createShippingMethodHandler },
    { descriptor: updateShippingMethodCommand, handler: updateShippingMethodHandler },
    { descriptor: beginPickupSelectionCommand, handler: beginPickupSelectionHandler(providers) },
    { descriptor: completePickupSelectionCommand, handler: completePickupSelectionHandler(providers) },
    { descriptor: createShipmentCommand, handler: createShipmentHandler(orders, providers, refunds) },
    { descriptor: recordProviderShipmentCommand, handler: recordProviderShipmentHandler },
    { descriptor: recordProviderStatusCommand, handler: recordProviderStatusHandler },
    { descriptor: recordProviderCallbackCommand, handler: recordProviderCallbackHandler },
    { descriptor: advanceShipmentStageCommand, handler: advanceShipmentStageHandler },
  ],
  queries: [
    { descriptor: checkoutShippingQuoteQuery, handler: checkoutShippingQuoteHandler },
    { descriptor: getShippingMethodQuery, handler: getShippingMethodHandler },
    { descriptor: listShippingMethodsQuery, handler: listShippingMethodsHandler },
    { descriptor: getPickupSelectionViewQuery, handler: getPickupSelectionViewHandler },
    { descriptor: getShipmentQuery, handler: getShipmentHandler },
    { descriptor: getShipmentForOrderQuery, handler: getShipmentForOrderHandler },
    { descriptor: getProviderShipmentRequestQuery, handler: getProviderShipmentRequestHandler },
    { descriptor: getProviderShipmentStatusRequestQuery, handler: getProviderShipmentStatusRequestHandler },
    { descriptor: getShipmentLabelInfoQuery, handler: getShipmentLabelInfoHandler },
  ],
  });
}
