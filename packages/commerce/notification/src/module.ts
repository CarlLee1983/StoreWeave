import packageJson from '../package.json';
import { type BoundModuleCapability, defineModule, type PlatformModule } from '@storeweave/kernel';
import type { NotificationsPort } from '@storeweave/notifications';
import { orderPaidV2, orderPlacedV3 } from '@storeweave/order';
import { shipmentArrivedV1, shipmentShippedV1 } from '@storeweave/shipping';
import {
  createQueueLifecycleDeliveryHandler, queueLifecycleDeliveryCommand, type NotificationOrderLookup,
} from './commands';
import { notificationMigrations } from './migrations';
import {
  createListLifecycleDeliveriesHandler, getLifecycleDeliveryHandler, getLifecycleDeliveryQuery, listLifecycleDeliveriesQuery,
} from './queries';

function queue(eventId: string, orderId: string, template: string, variables: Record<string, unknown>) {
  return async (_event: unknown, ctx: { executeCommand?: (name: string, input: unknown, idempotencyKey: string) => Promise<unknown> }) => {
    if (!ctx.executeCommand) throw new Error('Lifecycle notification subscriber lacks core command access');
    await ctx.executeCommand('commerce.notification.queueLifecycleDelivery', { eventId, orderId, template, variables }, `notification:queue:${eventId}:${template}`);
  };
}

/**
 * Notification owns which event tells whom what, not the Order or Shipment facts
 * that trigger it, and not the delivery: that belongs to the base capability.
 */
export function createNotificationModule(
  ordersBinding: BoundModuleCapability<NotificationOrderLookup>,
  options: { locale: string },
): PlatformModule {
  const orders = ordersBinding.value;
  let port: NotificationsPort | undefined;
  const notifications = () => {
    if (!port) throw new Error('Notification module was composed without the base notification capability');
    return port;
  };

  return defineModule({
    name: 'notification',
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [
      { name: 'platform', versionRange: '^0.1.0' },
      { name: 'platform-notifications', versionRange: '^0.1.0' },
    ] },
    capabilities: {
      required: [
        { from: 'order', capability: 'commerce.order.notification-lookup', versionRange: '^0.1.0' },
      ],
      bound: [ordersBinding],
    },
    data: { owns: ['notification_lifecycle_deliveries'] },
    migrations: notificationMigrations,
    bindPorts: (ports) => { port = ports.notifications; },
    permissions: [
      { key: 'notification:read', description: '讀取通知投遞紀錄', owner: 'notification' },
      { key: 'notification:system-write', description: '背景工作建立通知投遞', owner: 'notification' },
    ],
    commands: [
      { descriptor: queueLifecycleDeliveryCommand, handler: createQueueLifecycleDeliveryHandler({ orders, notifications, locale: options.locale }) },
    ],
    queries: [
      { descriptor: getLifecycleDeliveryQuery, handler: getLifecycleDeliveryHandler },
      { descriptor: listLifecycleDeliveriesQuery, handler: createListLifecycleDeliveriesHandler(notifications) },
    ],
    subscribers: [
      { eventName: orderPlacedV3.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(event.id, p.orderId, 'customer.order-placed', { orderNumber: p.orderNumber })(event, ctx);
      } },
      { eventName: orderPaidV2.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(event.id, p.orderId, 'customer.order-paid', { orderNumber: p.orderNumber })(event, ctx);
      } },
      { eventName: shipmentShippedV1.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(event.id, p.orderId, 'customer.shipment-shipped', { shipmentId: p.shipmentId })(event, ctx);
      } },
      { eventName: shipmentArrivedV1.name, handler: (event, ctx) => {
        const p = event.payload;
        return queue(event.id, p.orderId, 'customer.shipment-arrived', { shipmentId: p.shipmentId })(event, ctx);
      } },
    ],
  });
}
