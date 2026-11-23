import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand, defineQuery, PlatformError, type CommandContext, type QueryContext, type Tx } from '@storeweave/contracts';
import { deliveryEvidenceDto, resendEmailInput, resendEmailOutput, type NotificationsPort } from '@storeweave/notifications';
import { diningNotificationEvents, diningNotificationReference } from './notifications';
import { diningRequests } from './schema';

const permission = 'dining-reservation:manage';
const resendResource = 'dining-reservation-notification';
const requestInput = z.object({ number: z.string().regex(/^DR-[0-9A-F]{20}$/) }).strict();
const event = z.enum(diningNotificationEvents);
const notificationEvidence = deliveryEvidenceDto.pick({
  id: true, status: true, attempts: true, sentAt: true, updatedAt: true,
}).extend({ event }).strict();
const resendInput = resendEmailInput.extend({ number: requestInput.shape.number, event });

export const listDiningRequestNotificationsQuery = defineQuery({
  name: 'dining.reservation.listRequestNotifications',
  input: requestInput,
  output: z.object({ items: z.array(notificationEvidence) }).strict(),
  permission,
});

export const resendDiningRequestEmailCommand = defineCommand({
  name: 'dining.reservation.resendRequestEmail',
  input: resendInput,
  output: resendEmailOutput,
  permission,
  resource: input => ({ type: resendResource, id: input.deliveryId }),
  idempotency: 'required',
  idempotencyScope: 'actor',
});

export const diningNotificationOperatorPolicy = {
  id: 'dining.reservation.notification.operator',
  owner: 'dining-reservation',
  appliesTo: [permission],
  reason: 'Dining notification resend requires an operator',
  evaluate: ({ actor, resource }: { actor: CommandContext['actor']; resource?: { type: string } }) =>
    resource?.type === resendResource && (actor.type !== 'user' || !actor.id) ? 'deny' as const : 'abstain' as const,
};

async function findRequestId(db: Tx, number: string) {
  const [request] = await db.select({ id: diningRequests.id }).from(diningRequests)
    .where(eq(diningRequests.number, number)).limit(1);
  if (!request) throw PlatformError.notFound('Dining request');
  return request.id;
}

export function createListDiningRequestNotificationsHandler(notifications: () => NotificationsPort) {
  return async ({ number }: z.infer<typeof requestInput>, context: QueryContext) => {
    const id = await findRequestId(context.db, number);
    const notificationsByEvent = diningNotificationEvents.map(event => ({ event, reference: diningNotificationReference(id, event) }));
    const evidence = await notifications().evidenceByReference(notificationsByEvent.map(item => item.reference));
    const items = notificationsByEvent.flatMap(({ event, reference }) =>
      (evidence.get(reference) ?? []).filter(delivery => delivery.channel === 'email')
        .map(({ id, status, attempts, sentAt, updatedAt }) => ({ event, id, status, attempts, sentAt, updatedAt })));
    return { items };
  };
}

export function createResendDiningRequestEmailHandler(notifications: () => NotificationsPort) {
  return async ({ number, event, ...input }: z.infer<typeof resendInput>, context: CommandContext) => {
    const id = await findRequestId(context.tx, number);
    const reference = diningNotificationReference(id, event);
    return notifications().requestEmailResend(context, input, { reference });
  };
}
