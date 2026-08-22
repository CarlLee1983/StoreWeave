import { z } from 'zod';
import type { EventBus } from '@storeweave/event-bus';
import type { EventHandlerContext, Logger } from '@storeweave/contracts';
import type { JobHandler } from '@storeweave/jobs';

export const EVENT_DELIVERY_JOB = 'platform.event.deliver';

export const eventDeliveryPayload = z.object({
  outboxId: z.string().uuid(),
  subscriberId: z.string(),
  event: z.object({
    id: z.string().uuid(),
    name: z.string(),
    version: z.number().int(),
    occurredAt: z.coerce.date(),
    actorId: z.string(),
    correlationId: z.string(),
    payload: z.unknown(),
  }),
});

/**
 * 把一筆 Outbox 事件送給一個訂閱者。
 * 去重鍵是 `${outboxId}:${subscriberId}`，因此同一事件對同一訂閱者只會排入一次工作；
 * 工作本身失敗會重試，Extension 必須自己保證副作用冪等（SDK 提供 dedupeKey 給它用）。
 */
export function createEventDeliveryHandler(eventBus: EventBus, logger: Logger): JobHandler {
  return async (rawPayload, ctx) => {
    const { subscriberId, event } = eventDeliveryPayload.parse(rawPayload);
    const subscription = eventBus
      .subscribersFor(event.name)
      .find((s) => s.subscriberId === subscriberId);
    if (!subscription) {
      logger.warn({ subscriberId, event: event.name }, 'no subscriber found; dropping delivery');
      return;
    }
    const parsed = eventBus.parse(event as any);
    // Worker 在 JobContext 上掛了 executeCommand；Core 模組的訂閱者需要它才做得了事。
    const executeCommand = (ctx as { executeCommand?: EventHandlerContext['executeCommand'] }).executeCommand;
    await subscription.handler(parsed, { logger: ctx.logger, correlationId: event.correlationId, executeCommand });
  };
}
