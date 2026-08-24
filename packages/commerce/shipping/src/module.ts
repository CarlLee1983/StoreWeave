import { defineModule } from '@storeweave/kernel';
import {
  advanceShipmentStageCommand, advanceShipmentStageHandler, createShipmentCommand, createShipmentHandler,
  createShippingMethodCommand, createShippingMethodHandler, updateShippingMethodCommand, updateShippingMethodHandler,
} from './commands';
import { shippingEvents } from './events';
import { shippingMigrations } from './migrations';
import {
  checkoutShippingQuoteHandler, checkoutShippingQuoteQuery,
  getShipmentHandler, getShipmentQuery, getShippingMethodHandler, getShippingMethodQuery,
  listShippingMethodsHandler, listShippingMethodsQuery,
} from './queries';
import type { ShipmentOrderLookup } from './service';

/** Shipping is assembled with a narrow order read port, not direct order-table access. */
export function createShippingModule(orders: ShipmentOrderLookup) {
  return defineModule({
  name: 'shipping',
  migrations: shippingMigrations,
  events: shippingEvents,
  permissions: [
    { key: 'shipping:read', description: '讀取運送方式', owner: 'shipping' },
    // Shipment ids are operational data, not storefront-discoverable resources.
    { key: 'shipping:shipment-read', description: '讀取物流單', owner: 'shipping' },
    { key: 'shipping:write', description: '維護運送方式與物流單', owner: 'shipping' },
  ],
  commands: [
    { descriptor: createShippingMethodCommand, handler: createShippingMethodHandler },
    { descriptor: updateShippingMethodCommand, handler: updateShippingMethodHandler },
    { descriptor: createShipmentCommand, handler: createShipmentHandler(orders) },
    { descriptor: advanceShipmentStageCommand, handler: advanceShipmentStageHandler },
  ],
  queries: [
    { descriptor: checkoutShippingQuoteQuery, handler: checkoutShippingQuoteHandler },
    { descriptor: getShippingMethodQuery, handler: getShippingMethodHandler },
    { descriptor: listShippingMethodsQuery, handler: listShippingMethodsHandler },
    { descriptor: getShipmentQuery, handler: getShipmentHandler },
  ],
  });
}
