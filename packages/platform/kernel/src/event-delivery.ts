import { z } from 'zod';
import type { EventBus } from '@storeweave/event-bus';
import { eventDeliveryDedupeKey, EVENT_DELIVERY_JOB, type EventHandlerContext, type Logger } from '@storeweave/contracts';
import { JobQuarantineError, type JobHandler } from '@storeweave/jobs';
import type { JobPayloadContract } from './job-registry';

export { EVENT_DELIVERY_JOB };

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

export const eventDeliveryJobContract: JobPayloadContract = {
  currentVersion: 1,
  versions: { 1: eventDeliveryPayload },
};

/**
 * 把一筆 Outbox 事件送給一個訂閱者。
 * Queue occurrence fencing is deliberately separate from the stable event/subscriber
 * key. Dispatch preconditions are typed quarantine errors; subscriber business errors retry.
 */
export function createEventDeliveryHandler(eventBus: EventBus, logger: Logger): JobHandler {
  return async (rawPayload, ctx) => {
    const { subscriberId, event } = eventDeliveryPayload.parse(rawPayload);
    let descriptor;
    try { descriptor = eventBus.getEvent(event.name); }
    catch { throw new JobQuarantineError('event_unknown'); }
    if (descriptor.version !== event.version) throw new JobQuarantineError('event_version_invalid');
    const subscription = eventBus
      .subscribersFor(event.name)
      .find((s) => s.subscriberId === subscriberId);
    if (!subscription) {
      logger.warn({ subscriberId, event: event.name }, 'subscriber missing; quarantining delivery');
      throw new JobQuarantineError('subscriber_missing');
    }
    let parsed;
    try { parsed = eventBus.parse(event as any); }
    catch { throw new JobQuarantineError('event_payload_invalid'); }
    // Worker 在 JobContext 上掛了 executeCommand；Core 模組的訂閱者需要它才做得了事。
    const executeCommand = (ctx as { executeCommand?: EventHandlerContext['executeCommand'] }).executeCommand;
    await subscription.handler(parsed, {
      logger: ctx.logger,
      correlationId: event.correlationId,
      eventId: event.id,
      idempotencyKey: eventDeliveryDedupeKey(event.id, subscriberId),
      executeCommand,
    });
  };
}
