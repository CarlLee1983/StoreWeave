import packageJson from '../package.json';
import { defineModule, type PlatformModule } from '@storeweave/kernel';
import { orderMigrations } from './migrations';
import { orderEvents } from './events';
import {
  cancelOrderCommand, checkoutCartCommand, createCancelOrderHandler, createCheckoutCartHandler, createExpireOrderHandler, createExpireReservationJob, createPayOrderHandler, createPlaceOrderHandler, createProcessPaymentJob, createRecordPaymentResultHandler,
  expireOrderCommand, payOrderCommand, placeOrderCommand, recordPaymentResultCommand, EXPIRE_ORDER_JOB, PROCESS_PAYMENT_JOB, expireOrderJobPayload, processPaymentJobPayload, type OrderModuleDeps,
} from './commands';
import {
  getOrderHandler, getOrderQuery, listOrdersHandler, listOrdersQuery,
  salesSummaryHandler, salesSummaryQuery,
} from './queries';

/**
 * order 模組需要 payment provider，因此以工廠函式注入 —— Core 本身不認識任何金流廠商。
 */
export function createOrderModule(deps: OrderModuleDeps): PlatformModule {
  return defineModule({
    name: 'order',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'catalog', versionRange: '^0.1.0' },
    { name: 'cart', versionRange: '^0.1.0' },
    { name: 'coupon', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
    { name: 'inventory', versionRange: '^0.1.0' },
    { name: 'loyalty', versionRange: '^0.1.0' },
    { name: 'promotion', versionRange: '^0.1.0' },
    { name: 'shipping', versionRange: '^0.1.0' },
  ] },
  capabilities: { provides: ['commerce.order.shipment-lookup', 'commerce.order.refund-operations', 'commerce.order.return-operations', 'commerce.order.invoice-lookup', 'commerce.order.notification-lookup'] },
  data: { owns: ['order_number_seq', 'order_orders', 'order_lines', 'order_payments', 'order_adjustments', 'order_deliveries'] },
    migrations: orderMigrations,
    events: orderEvents,
    permissions: [
      { key: 'order:read', description: '讀取訂單', owner: 'order' },
      { key: 'order:write', description: '建立、付款、取消訂單', owner: 'order' },
      { key: 'analytics:read', description: '讀取銷售統計', owner: 'order' },
    ],
    commands: [
      { descriptor: placeOrderCommand, handler: createPlaceOrderHandler(deps) },
      { descriptor: checkoutCartCommand, handler: createCheckoutCartHandler(deps) },
      { descriptor: payOrderCommand, handler: createPayOrderHandler(deps) },
      { descriptor: recordPaymentResultCommand, handler: createRecordPaymentResultHandler() },
      { descriptor: expireOrderCommand, handler: createExpireOrderHandler() },
      { descriptor: cancelOrderCommand, handler: createCancelOrderHandler(deps) },
    ],
    jobs: [
      { type: PROCESS_PAYMENT_JOB, handler: createProcessPaymentJob(deps), jobContractV1: { currentVersion: 1, versions: { 1: processPaymentJobPayload } } },
      { type: EXPIRE_ORDER_JOB, handler: createExpireReservationJob(), jobContractV1: { currentVersion: 1, versions: { 1: expireOrderJobPayload } } },
    ],
    queries: [
      { descriptor: getOrderQuery, handler: getOrderHandler },
      { descriptor: listOrdersQuery, handler: listOrdersHandler },
      { descriptor: salesSummaryQuery, handler: salesSummaryHandler },
    ],
  });
}
