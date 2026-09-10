import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import { PermanentJobError, type JobHandler } from '@storeweave/jobs';
import type { NotificationService } from './service';
import {
  listDeliveriesInput, listDeliveriesOutput, listInboxInput, listInboxOutput, markInboxReadInput, markInboxReadOutput,
  notificationDto, sendNotificationInput,
} from './types';

/** Composition hands these a getter: the service exists only after the database does. */
type ServiceRef = () => NotificationService | undefined;

function required(service: ServiceRef): NotificationService {
  const instance = service();
  if (!instance) throw PlatformError.internal('Notification service is not initialized');
  return instance;
}

export const sendNotificationCommand = defineCommand({
  name: 'platform.notifications.send',
  summary: '建立一則通知，並依通道各自投遞',
  input: sendNotificationInput,
  output: notificationDto,
  permission: 'notifications:send',
  idempotency: 'required',
  audit: { action: 'notification.sent', resourceType: 'notification', resourceId: (_input, output: { id?: string }) => output?.id },
});

export function createSendNotificationHandler(service: ServiceRef) {
  return async (input: z.infer<typeof sendNotificationInput>, ctx: CommandContext) => {
    return required(service).send(ctx.tx, input, job => ctx.enqueue(job), ctx.now);
  };
}

export const listInboxQuery = defineQuery({
  name: 'platform.notifications.listInbox',
  summary: '讀取自己的站內通知',
  input: listInboxInput,
  output: listInboxOutput,
  permission: 'notifications:inbox',
});

/** An inbox belongs to exactly one actor; there is no parameter to read someone else's. */
function inboxOwner(actor: { id: string; type: string }): string {
  if (actor.type !== 'user' && actor.type !== 'customer') {
    throw PlatformError.forbidden('Only a signed-in account has an in-app inbox');
  }
  return actor.id;
}

export function createListInboxHandler(service: ServiceRef) {
  return async (input: z.infer<typeof listInboxInput>, ctx: QueryContext) => {
    return required(service).inbox(inboxOwner(ctx.actor), input);
  };
}

export const markInboxReadCommand = defineCommand({
  name: 'platform.notifications.markRead',
  summary: '把自己的站內通知標記為已讀',
  input: markInboxReadInput,
  output: markInboxReadOutput,
  permission: 'notifications:inbox',
  idempotency: 'optional',
});

export function createMarkInboxReadHandler(service: ServiceRef) {
  return async (input: z.infer<typeof markInboxReadInput>, ctx: CommandContext) => {
    const updated = await required(service).markRead(ctx.tx, inboxOwner(ctx.actor), input.ids, ctx.now);
    return { updated, readAt: ctx.now };
  };
}

export const listDeliveriesQuery = defineQuery({
  name: 'platform.notifications.listDeliveries',
  summary: '列出通知投遞證據（收件人遮蔽）',
  input: listDeliveriesInput,
  output: listDeliveriesOutput,
  permission: 'notifications:read',
});

export function createListDeliveriesHandler(service: ServiceRef) {
  return async (input: z.infer<typeof listDeliveriesInput>) => required(service).evidence(input);
}

export const notificationDeliverJobPayload = z.object({ deliveryId: z.string().uuid() }).strict();

export function createNotificationDeliverJob(service: ServiceRef): JobHandler {
  return async raw => {
    const payload = notificationDeliverJobPayload.parse(raw);
    const instance = service();
    if (!instance) throw new PermanentJobError('Notification service is not initialized');
    await instance.deliver(payload.deliveryId);
  };
}
