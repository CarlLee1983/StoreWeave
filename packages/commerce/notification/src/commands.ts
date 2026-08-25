import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { lifecycleDeliveryDto, queueLifecycleDeliveryInput, recordLifecycleDeliveryInput, type LifecycleDeliveryDto } from './dto';
import { NotificationRepository, toLifecycleDeliveryDto } from './repository';

export const LIFECYCLE_NOTIFICATION_JOB = 'commerce.notification.deliver-lifecycle';

export interface NotificationOrderLookup {
  recipientForNotification(db: DrizzleDb | Tx, orderId: string): Promise<{ email: string; orderNumber: string } | null>;
}

const repository = new NotificationRepository();

export const queueLifecycleDeliveryCommand = defineCommand({
  name: 'commerce.notification.queueLifecycleDelivery', summary: '建立訂單生命週期通知投遞',
  input: queueLifecycleDeliveryInput, output: lifecycleDeliveryDto, permission: 'notification:system-write', idempotency: 'required',
});

export function createQueueLifecycleDeliveryHandler(orders: NotificationOrderLookup) {
  return async (input: z.infer<typeof queueLifecycleDeliveryInput>, ctx: CommandContext): Promise<LifecycleDeliveryDto> => {
    const existing = await repository.findByEventTemplate(ctx.tx, input.eventId, input.template);
    if (existing) return toLifecycleDeliveryDto(existing);

    const recipient = await orders.recipientForNotification(ctx.tx, input.orderId);
    if (!recipient) throw PlatformError.notFound('Order', input.orderId);
    const id = randomUUID();
    // The provider's idempotency key must survive an event replay, worker
    // crash, and every retry.  It is persisted before any network I/O occurs.
    const row = await repository.insert(ctx.tx, {
      id, eventId: input.eventId, orderId: input.orderId, template: input.template,
      reference: `lifecycle:${input.eventId}:${input.template}`,
      recipientEmail: recipient.email, variables: { orderNumber: recipient.orderNumber, ...input.variables },
      status: 'pending', attempts: 0, createdAt: ctx.now, updatedAt: ctx.now,
    });
    // A concurrent event delivery may have won the unique event/template key.
    // Read its durable fact rather than enqueueing a second external effect.
    if (!row) {
      const concurrent = await repository.findByEventTemplate(ctx.tx, input.eventId, input.template);
      if (!concurrent) throw PlatformError.internal('Lifecycle notification delivery disappeared');
      return toLifecycleDeliveryDto(concurrent);
    }
    await ctx.enqueue({ type: LIFECYCLE_NOTIFICATION_JOB, payload: { deliveryId: row.id }, dedupeKey: `notification:${row.id}` });
    return toLifecycleDeliveryDto(row);
  };
}

export const recordLifecycleDeliveryCommand = defineCommand({
  name: 'commerce.notification.recordLifecycleDelivery', summary: '記錄通知 provider 投遞結果',
  input: recordLifecycleDeliveryInput, output: lifecycleDeliveryDto, permission: 'notification:system-write', idempotency: 'required',
});

export const recordLifecycleDeliveryHandler = async (
  input: z.infer<typeof recordLifecycleDeliveryInput>, ctx: CommandContext,
): Promise<LifecycleDeliveryDto> => {
  if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only notification workers may record delivery results');
  const row = await repository.lockById(ctx.tx, input.id);
  if (!row) throw PlatformError.notFound('LifecycleDelivery', input.id);
  if (row.status === 'sent') {
    if (input.status !== 'sent' || input.providerRef !== row.providerRef) {
      throw PlatformError.conflict(`Lifecycle delivery ${row.id} already has different provider evidence`);
    }
    return toLifecycleDeliveryDto(row);
  }
  const updated = await repository.update(ctx.tx, row.id, {
    status: input.status, providerRef: input.providerRef,
    attempts: row.attempts + 1, lastError: input.status === 'failed' ? input.error! : null,
    sentAt: input.status === 'sent' ? ctx.now : null, updatedAt: ctx.now,
  });
  if (!updated) throw PlatformError.internal(`Lifecycle delivery ${row.id} disappeared`);
  return toLifecycleDeliveryDto(updated);
};
