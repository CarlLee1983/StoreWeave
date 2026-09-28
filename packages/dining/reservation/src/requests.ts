import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { NotificationsPort } from '@storeweave/notifications';
import { DiningReservationRepository } from './repository';
import { diningRequestRateEvents, diningRequests, diningRequestSnapshots } from './schema';
import { resolveLocalStart } from './schedule';
import { localDateSchema, localTimeSchema } from './types';

const repository = new DiningReservationRepository();
// Leave one cleanup interval between rate-event expiry and Dining's PII deadline.
export const DINING_RATE_CLEANUP_MS = 60 * 60_000;

const frequencySchema = z.object({ limit: z.number().int().positive(), windowMinutes: z.number().int().positive() }).strict();
export const publicRequestPolicySchema = z.object({
  source: frequencySchema,
  recipient: frequencySchema,
  piiRetentionDays: z.number().int().positive(),
  identityKey: z.instanceof(Buffer).refine(key => key.length >= 32, 'Identity key must contain at least 32 bytes'),
}).strict().refine(policy =>
  Math.max(policy.source.windowMinutes, policy.recipient.windowMinutes) + DINING_RATE_CLEANUP_MS / 60_000
    <= policy.piiRetentionDays * 1440,
{ message: 'Frequency windows and cleanup interval must fit within Dining retention' });
export type PublicRequestPolicy = z.infer<typeof publicRequestPolicySchema>;

const requestInput = z.object({
  submissionKey: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  /** Supplied by a trusted public adapter, never copied from a caller-controlled header. */
  sourceIdentity: z.string().min(16).max(200),
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,29}$/),
  email: z.string().trim().email().max(320),
  partySize: z.number().int().min(1).max(1000),
  date: localDateSchema,
  time: localTimeSchema,
  note: z.string().max(2000).optional(),
}).strict();
const requestOutput = z.object({ number: z.string(), status: z.literal('pending') }).strict();

export const submitDiningRequestCommand = defineCommand({
  name: 'dining.reservation.submitRequest', input: requestInput, output: requestOutput,
  permission: 'dining-reservation:request', idempotency: 'none',
  summary: 'The trusted adapter supplies sourceIdentity and submissionKey as input; omit the Command Bus idempotency option',
});

const readInput = z.object({ number: z.string().min(1) }).strict();
const readOutput = z.object({
  number: z.string(), status: z.literal('pending'), name: z.string(), phone: z.string(), email: z.string(),
  note: z.string().nullable(), partySize: z.number().int(), startAt: z.date(), endAt: z.date(),
}).strict();
export const getDiningRequestQuery = defineQuery({
  name: 'dining.reservation.getRequest', input: readInput, output: readOutput,
  permission: 'dining-reservation:manage',
});

export const expireDiningRateEventsCommand = defineCommand({
  name: 'dining.reservation.expireRateEvents', input: z.object({}).strict(),
  output: z.object({ deleted: z.number().int().nonnegative() }).strict(),
  permission: 'dining-reservation:system-write', idempotency: 'none',
});

export async function expireDiningRateEventsHandler(_input: unknown, context: CommandContext) {
  if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system worker may expire Dining rate events');
  const rows = await context.tx.delete(diningRequestRateEvents)
    .where(lte(diningRequestRateEvents.expiresAt, context.now)).returning({ id: diningRequestRateEvents.id });
  return { deleted: rows.length };
}

export function createSubmitDiningRequestHandler(policy: PublicRequestPolicy, notifications: () => NotificationsPort) {
  const validated = publicRequestPolicySchema.parse(policy);
  const digest = (kind: string, value: string) => createHmac('sha256', validated.identityKey)
    .update(kind).update('\0').update(value).digest('hex');
  return async (input: z.infer<typeof requestInput>, context: CommandContext) => {
    const venue = await repository.lockSettings(context.tx);
    if (!venue) throw PlatformError.conflict('Configure the Dining venue before accepting requests');
    const submissionHash = digest('submission', input.submissionKey.toLowerCase());
    const [replay] = await context.tx.select({ number: diningRequests.number }).from(diningRequests)
      .where(eq(diningRequests.submissionHash, submissionHash)).limit(1);
    if (replay) return { number: replay.number, status: 'pending' as const };

    const now = context.now;
    const sourceHash = digest('source', input.sourceIdentity);
    const recipientHash = digest('recipient', input.email.toLowerCase());
    await context.tx.delete(diningRequestRateEvents).where(lte(diningRequestRateEvents.expiresAt, now));
    // This lock also serializes rate-limit increments and capacity-changing writes.
    const sourceCount = await context.tx.select({ count: sql<number>`count(*)::int` }).from(diningRequestRateEvents)
      .where(and(eq(diningRequestRateEvents.sourceHash, sourceHash),
        gt(diningRequestRateEvents.createdAt, new Date(now.getTime() - validated.source.windowMinutes * 60_000))));
    const recipientCount = await context.tx.select({ count: sql<number>`count(*)::int` }).from(diningRequestRateEvents)
      .where(and(eq(diningRequestRateEvents.recipientHash, recipientHash),
        gt(diningRequestRateEvents.createdAt, new Date(now.getTime() - validated.recipient.windowMinutes * 60_000))));
    if (sourceCount[0]!.count >= validated.source.limit || recipientCount[0]!.count >= validated.recipient.limit) {
      throw PlatformError.conflict('Dining request frequency limit exceeded');
    }

    const startAt = resolveLocalStart(input.date, input.time, venue.timezone);
    if (startAt && !await repository.hasAvailableTable(context.tx, input.partySize, startAt,
      new Date(startAt.getTime() + venue.occupancyMinutes * 60_000))) {
      throw PlatformError.conflict('No Dining table type has capacity for this interval');
    }
    const snapshot = await repository.insertRequestSnapshot(context.tx, {
      date: input.date, time: input.time, partySize: input.partySize, createdAt: now,
    });
    const number = `DR-${randomBytes(10).toString('hex').toUpperCase()}`;
    await context.tx.insert(diningRequests).values({
      id: snapshot.id, submissionHash, number, name: input.name, phone: input.phone,
      email: input.email, note: input.note ?? null, status: 'pending', createdAt: now,
    });
    await context.tx.insert(diningRequestRateEvents).values({
      id: randomUUID(), sourceHash, recipientHash, createdAt: now,
      expiresAt: new Date(now.getTime() + Math.max(validated.source.windowMinutes, validated.recipient.windowMinutes) * 60_000),
    });
    await notifications().send(context.tx, {
      reference: `dining-reservation:received:${snapshot.id}`, channels: ['email'],
      recipient: { email: input.email, name: input.name },
      template: { id: 'dining.reservation.received', version: 1, email: {
        subject: 'We received your dining request',
        text: 'We received your dining request {number}. This is not a confirmed reservation.',
        html: '<p>We received your dining request {number}. This is not a confirmed reservation.</p>',
      } }, variables: { number },
    }, job => context.enqueue(job), now);
    return { number, status: 'pending' as const };
  };
}

export async function getDiningRequestHandler(input: z.infer<typeof readInput>, context: QueryContext) {
  const [row] = await context.db.select({
    number: diningRequests.number, status: diningRequests.status, name: diningRequests.name,
    phone: diningRequests.phone, email: diningRequests.email, note: diningRequests.note,
    partySize: diningRequestSnapshots.partySize, startAt: diningRequestSnapshots.startAt,
    endAt: diningRequestSnapshots.endAt,
  }).from(diningRequests).innerJoin(diningRequestSnapshots, eq(diningRequests.id, diningRequestSnapshots.id))
    .where(eq(diningRequests.number, input.number)).limit(1);
  if (!row) throw PlatformError.notFound('Dining request', input.number);
  return readOutput.parse(row);
}
