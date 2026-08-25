import { defineModule } from '@storeweave/kernel';
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
export function createShippingModule(orders: ShipmentOrderLookup, providers: ProviderRegistry, refunds?: ShipmentRefundGuard) {
  return defineModule({
  name: 'shipping',
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
