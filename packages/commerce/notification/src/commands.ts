import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import type { NotificationsPort } from '@storeweave/notifications';
import { lifecycleDeliveryDto, queueLifecycleDeliveryInput, type LifecycleDeliveryDto } from './dto';
import { NotificationRepository, toLifecycleDeliveryDto } from './repository';
import { LIFECYCLE_TEMPLATES } from './templates';

export interface NotificationOrderLookup {
  recipientForNotification(db: DrizzleDb | Tx, orderId: string): Promise<{ email: string; orderNumber: string } | null>;
}

const repository = new NotificationRepository();

export const queueLifecycleDeliveryCommand = defineCommand({
  name: 'commerce.notification.queueLifecycleDelivery', summary: '建立訂單生命週期通知投遞',
  input: queueLifecycleDeliveryInput, output: lifecycleDeliveryDto, permission: 'notification:system-write', idempotency: 'required',
});

export interface LifecycleNotificationDeps {
  readonly orders: NotificationOrderLookup;
  /** Base notification capability; commerce owns the mapping, not the delivery. */
  readonly notifications: () => NotificationsPort;
  readonly locale: string;
}

/**
 * 記下「這個事件該通知誰、用哪個模板」，並在同一筆交易裡把投遞交給 base 通知能力。
 * 投遞狀態不在這裡維護——重複記一份只會多一個可能跟事實不一致的欄位。
 */
export function createQueueLifecycleDeliveryHandler(deps: LifecycleNotificationDeps) {
  return async (input: z.infer<typeof queueLifecycleDeliveryInput>, ctx: CommandContext): Promise<LifecycleDeliveryDto> => {
    const existing = await repository.findByEventTemplate(ctx.tx, input.eventId, input.template);
    if (existing) return toLifecycleDeliveryDto(existing);

    const recipient = await deps.orders.recipientForNotification(ctx.tx, input.orderId);
    if (!recipient) throw PlatformError.notFound('Order', input.orderId);
    const id = randomUUID();
    // 這個 reference 就是 base 那邊的通知識別：事件重播、worker 當掉、每一次重試
    // 都得到同一個值，因此不會有第二封信。
    const reference = `lifecycle:${input.eventId}:${input.template}`;
    const variables = { orderNumber: recipient.orderNumber, ...input.variables };
    const row = await repository.insert(ctx.tx, {
      id, eventId: input.eventId, orderId: input.orderId, template: input.template,
      reference, recipientEmail: recipient.email, variables,
      status: 'pending', attempts: 0, createdAt: ctx.now, updatedAt: ctx.now,
    });
    // 併發的另一筆已經拿到 event/template 唯一鍵。讀它的事實，不要再交一次投遞。
    if (!row) {
      const concurrent = await repository.findByEventTemplate(ctx.tx, input.eventId, input.template);
      if (!concurrent) throw PlatformError.internal('Lifecycle notification delivery disappeared');
      return toLifecycleDeliveryDto(concurrent);
    }
    const template = LIFECYCLE_TEMPLATES[input.template];
    await deps.notifications().send(ctx.tx, {
      reference, channels: ['email'], locale: deps.locale,
      recipient: { email: recipient.email },
      template: { id: template.id, version: template.version, email: template.email },
      variables,
    }, job => ctx.enqueue(job), ctx.now);
    return toLifecycleDeliveryDto(row);
  };
}
