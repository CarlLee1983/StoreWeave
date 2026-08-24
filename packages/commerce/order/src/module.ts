import { defineModule, type PlatformModule } from '@storeweave/kernel';
import { orderMigrations } from './migrations';
import { orderEvents } from './events';
import {
  cancelOrderCommand, checkoutCartCommand, createCancelOrderHandler, createCheckoutCartHandler, createExpireOrderHandler, createExpireReservationJob, createMarkPaidHandler, createPayOrderHandler, createPlaceOrderHandler, createProcessPaymentJob, createRecordPaymentResultHandler,
  expireOrderCommand, markPaidCommand, payOrderCommand, placeOrderCommand, recordPaymentResultCommand, EXPIRE_ORDER_JOB, PROCESS_PAYMENT_JOB, type OrderModuleDeps,
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
      { descriptor: markPaidCommand, handler: createMarkPaidHandler() },
      { descriptor: recordPaymentResultCommand, handler: createRecordPaymentResultHandler() },
      { descriptor: expireOrderCommand, handler: createExpireOrderHandler() },
      { descriptor: cancelOrderCommand, handler: createCancelOrderHandler(deps) },
    ],
    jobs: [
      { type: PROCESS_PAYMENT_JOB, handler: createProcessPaymentJob(deps) },
      { type: EXPIRE_ORDER_JOB, handler: createExpireReservationJob() },
    ],
    queries: [
      { descriptor: getOrderQuery, handler: getOrderHandler },
      { descriptor: listOrdersQuery, handler: listOrdersHandler },
      { descriptor: salesSummaryQuery, handler: salesSummaryHandler },
    ],
  });
}
