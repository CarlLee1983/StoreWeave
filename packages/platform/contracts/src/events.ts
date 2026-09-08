import { z, type ZodType, type ZodTypeDef } from 'zod';

export type EventSchema<T> = ZodType<T, ZodTypeDef, any>;

/** 事件名稱格式：<bounded-context>.<aggregate>.<action>.v<N> */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+\.v[0-9]+$/;

export interface DomainEventDescriptor<P = unknown> {
  readonly name: string;
  readonly version: number;
  readonly payload: EventSchema<P>;
  readonly summary?: string;
}

export function defineEvent<P>(def: { name: string; payload: EventSchema<P>; summary?: string }): DomainEventDescriptor<P> {
  if (!EVENT_NAME_PATTERN.test(def.name)) {
    throw new Error(`Invalid event name "${def.name}"; expected <context>.<aggregate>.<action>.vN (e.g. shop.thing.happened.v1)`);
  }
  const version = Number(def.name.slice(def.name.lastIndexOf('.v') + 2));
  return { name: def.name, version, payload: def.payload, summary: def.summary };
}

export const domainEventEnvelope = z.object({
  id: z.string().uuid(),
  name: z.string().regex(EVENT_NAME_PATTERN),
  version: z.number().int().positive(),
  occurredAt: z.coerce.date(),
  actorId: z.string(),
  correlationId: z.string(),
  payload: z.unknown(),
});

export interface DomainEvent<P = unknown> {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly occurredAt: Date;
  readonly actorId: string;
  readonly correlationId: string;
  readonly payload: P;
}

/**
 * Outbox fan-out delivers each event to one subscriber through this job type, keyed by
 * `evt:<eventId>:<subscriberId>`. Kernel dispatches it and the outbox store lists its
 * quarantines, so the identity lives here rather than being duplicated on both sides.
 */
export const EVENT_DELIVERY_JOB = 'platform.event.deliver';

export function eventDeliveryDedupeKey(eventId: string, subscriberId: string): string {
  return `evt:${eventId}:${subscriberId}`;
}
