import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { PlatformModule } from '@storeweave/kernel';
import type { NotificationsPort } from '@storeweave/notifications';
import { diningRequests, diningRequestSnapshots } from './schema';

export const DINING_NOTIFICATION_REFERENCE_PREFIX = 'dining-reservation:';
export const diningNotificationEvents = ['received', 'accepted', 'rejected', 'cancelled'] as const;
type DiningNotificationEvent = (typeof diningNotificationEvents)[number];

export function diningNotificationReference(requestId: string, event: DiningNotificationEvent) {
  return `${DINING_NOTIFICATION_REFERENCE_PREFIX}${event}:${requestId}`;
}

const jobType = 'dining.reservation.materialize-notification';
const notificationInput = z.object({ requestId: z.string().uuid(), event: z.enum(diningNotificationEvents) }).strict();

export async function enqueueDiningNotification(context: CommandContext, requestId: string, event: DiningNotificationEvent) {
  await context.enqueue({ type: jobType, payload: { requestId, event }, dedupeKey: diningNotificationReference(requestId, event) });
}

export const materializeDiningNotificationCommand = defineCommand({
  name: 'dining.reservation.materializeNotification',
  input: notificationInput, output: z.object({}).strict(),
  permission: 'dining-reservation:system-write', idempotency: 'required',
});

export const diningNotificationJob = {
  type: jobType,
  jobContractV1: { currentVersion: 1, versions: { 1: notificationInput } },
  handler: async (payload, context) => {
    if (!context.executeCommand) throw new Error('Dining notifications require the command bridge');
    await context.executeCommand(materializeDiningNotificationCommand.name, payload, context.occurrenceId);
  },
} satisfies NonNullable<PlatformModule['jobs']>[number];

const customerMessages = {
  received: {
    subject: 'We received your dining request',
    message: 'We received your dining request {number}. This is not a confirmed reservation.',
  },
  accepted: {
    subject: 'Your dining reservation is confirmed',
    message: 'Your dining reservation {number} is confirmed for {date} at {time} for a party of {partySize}.',
  },
  rejected: {
    subject: 'We could not accept your dining request',
    message: 'We could not accept your dining request {number}.',
  },
  cancelled: {
    subject: 'Your dining reservation was cancelled',
    message: 'Your dining reservation {number} was cancelled.',
  },
} satisfies Record<DiningNotificationEvent, { subject: string; message: string }>;

export function createMaterializeDiningNotificationHandler(notifications: () => NotificationsPort) {
  return async ({ requestId, event }: z.infer<typeof notificationInput>, context: CommandContext) => {
    if (context.actor.type !== 'system') throw PlatformError.forbidden('Only a system worker may materialize Dining notifications');
    const [request] = await context.tx.select({
      number: diningRequests.number, email: diningRequests.email, name: diningRequests.name,
      reason: diningRequests.customerReason, date: diningRequestSnapshots.startDate,
      time: diningRequestSnapshots.startTime, partySize: diningRequestSnapshots.partySize,
    }).from(diningRequests).innerJoin(diningRequestSnapshots, eq(diningRequests.id, diningRequestSnapshots.id))
      .where(eq(diningRequests.id, requestId)).limit(1);
    if (!request) throw PlatformError.notFound('Dining request');

    // A cancellation can happen before the acceptance email is materialized.
    // The queued event owns the lifecycle meaning and the snapshot owns its date, start and party size.
    const { subject, message } = customerMessages[event];
    const hasReason = event === 'cancelled' || (event === 'rejected' && request.reason !== null);
    await notifications().send(context.tx, {
      reference: diningNotificationReference(requestId, event), channels: ['email'],
      recipient: { email: request.email, name: request.name },
      template: { id: `dining.reservation.${event}`, version: 1, email: {
        subject,
        text: message + (hasReason ? '\n\nReason: {reason}' : ''),
        html: `<p>${message}</p>` + (hasReason ? '<p>Reason: {reason}</p>' : ''),
      } },
      variables: {
        number: request.number,
        ...(event === 'accepted' ? { date: request.date, time: request.time, partySize: request.partySize } : {}),
        ...(hasReason ? { reason: request.reason } : {}),
      },
    }, job => context.enqueue(job), context.now);
    return {};
  };
}
