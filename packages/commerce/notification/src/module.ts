import packageJson from '../package.json';
import { type BoundModuleCapability, defineModule, type PlatformModule } from '@storeweave/kernel';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import { orderPaidV2, orderPlacedV3 } from '@storeweave/order';
import { shipmentArrivedV1, shipmentShippedV1 } from '@storeweave/shipping';
import {
  createQueueLifecycleDeliveryHandler, LIFECYCLE_NOTIFICATION_JOB,
  queueLifecycleDeliveryCommand, recordLifecycleDeliveryCommand, recordLifecycleDeliveryHandler,
  type NotificationOrderLookup,
} from './commands';
import { createLifecycleNotificationJob } from './jobs';
import { notificationMigrations } from './migrations';
import {
  getLifecycleDeliveryHandler, getLifecycleDeliveryQuery,
  listLifecycleDeliveriesHandler, listLifecycleDeliveriesQuery,
} from './queries';

function queue(providers: ProviderRegistry, eventId: string, orderId: string, template: string, variables: Record<string, unknown>) {
  return async (_event: unknown, ctx: { executeCommand?: (name: string, input: unknown, idempotencyKey: string) => Promise<unknown> }) => {
    // The core lifecycle module is always installed, while notification is an
    // optional extension. Do not create retrying jobs that can never deliver
    // when this store deliberately has no notification provider.
    if (!providers.has('notification')) return;
    if (!ctx.executeCommand) throw new Error('Lifecycle notification subscriber lacks core command access');
    await ctx.executeCommand('commerce.notification.queueLifecycleDelivery', { eventId, orderId, template, variables }, `notification:queue:${eventId}:${template}`);
  };
}

/** Notification owns delivery evidence, not the Order or Shipment facts that trigger it. */
export function createNotificationModule(ordersBinding: BoundModuleCapability<NotificationOrderLookup>, providers: ProviderRegistry): PlatformModule {
  const orders = ordersBinding.value;

  return defineModule({
    name: 'notification',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
  capabilities: {
    required: [
      { from: 'order', capability: 'commerce.order.notification-lookup', versionRange: '^0.1.0' },
    ],
    bound: [ordersBinding],
  },
  data: { owns: ['notification_lifecycle_deliveries'] },
    migrations: notificationMigrations,
    permissions: [
      { key: 'notification:read', description: '讀取通知投遞紀錄', owner: 'notification' },
      { key: 'notification:system-write', description: '背景工作記錄通知投遞結果', owner: 'notification' },
    ],
    commands: [
      { descriptor: queueLifecycleDeliveryCommand, handler: createQueueLifecycleDeliveryHandler(orders) },
      { descriptor: recordLifecycleDeliveryCommand, handler: recordLifecycleDeliveryHandler },
    ],
    queries: [
      { descriptor: getLifecycleDeliveryQuery, handler: getLifecycleDeliveryHandler },
      { descriptor: listLifecycleDeliveriesQuery, handler: listLifecycleDeliveriesHandler },
    ],
    jobs: [{ type: LIFECYCLE_NOTIFICATION_JOB, handler: createLifecycleNotificationJob(providers) }],
    subscribers: [
      { eventName: orderPlacedV3.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(providers, event.id, p.orderId, 'customer.order-placed', { orderNumber: p.orderNumber })(event, ctx);
      } },
      { eventName: orderPaidV2.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(providers, event.id, p.orderId, 'customer.order-paid', { orderNumber: p.orderNumber })(event, ctx);
      } },
      { eventName: shipmentShippedV1.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(providers, event.id, p.orderId, 'customer.shipment-shipped', { shipmentId: p.shipmentId })(event, ctx);
      } },
      { eventName: shipmentArrivedV1.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(providers, event.id, p.orderId, 'customer.shipment-arrived', { shipmentId: p.shipmentId })(event, ctx);
      } },
    ],
  });
}
