import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { enqueueDiningNotification } from './notifications';
import { DiningReservationRepository, diningRequestDecision } from './repository';
import { diningCapacityCommitments, diningRequests } from './schema';

const repository = new DiningReservationRepository();
const permission = 'dining-reservation:manage';
const decisionInput = z.object({ number: z.string().regex(/^DR-[0-9A-F]{20}$/) }).strict();
// Unicode mode excludes lone surrogates while allowing valid supplementary characters.
const reasonSchema = z.string().trim().max(2000)
  .regex(/^[^\u0000\uD800-\uDFFF]*$/u, 'Reason must be valid text without NUL characters');
const rejectInput = decisionInput.extend({ reason: reasonSchema.optional() });
const cancelInput = decisionInput.extend({ reason: reasonSchema.min(1) });

export const acceptDiningRequestCommand = defineCommand({
  name: 'dining.reservation.acceptRequest', input: decisionInput,
  output: decisionInput.extend({ status: z.literal('accepted') }),
  permission, idempotency: 'required', idempotencyScope: 'actor',
});

export const rejectDiningRequestCommand = defineCommand({
  name: 'dining.reservation.rejectRequest', input: rejectInput,
  output: decisionInput.extend({ status: z.literal('rejected') }),
  permission, idempotency: 'required', idempotencyScope: 'actor',
});

export const cancelDiningReservationCommand = defineCommand({
  name: 'dining.reservation.cancelReservation', input: cancelInput,
  output: decisionInput.extend({ status: z.literal('cancelled') }),
  permission, idempotency: 'required', idempotencyScope: 'actor',
});

async function requestAtStatus(number: string, status: 'pending' | 'accepted', context: CommandContext) {
  // The venue lock serializes lifecycle, availability and schedule decisions.
  await repository.lockSettings(context.tx);
  const [request] = await context.tx.select({
    id: diningRequests.id, number: diningRequests.number, rejectedAt: diningRequests.rejectedAt,
    acceptedAt: diningCapacityCommitments.acceptedAt, cancelledAt: diningCapacityCommitments.cancelledAt,
  }).from(diningRequests).leftJoin(diningCapacityCommitments, eq(diningRequests.id, diningCapacityCommitments.requestId))
    .where(eq(diningRequests.number, number)).limit(1);
  if (!request) throw PlatformError.notFound('Dining request');
  if (diningRequestDecision(request).status !== status) throw PlatformError.conflict(`This Dining request is not ${status}`);
  return request;
}

async function auditDecision<Status extends 'accepted' | 'rejected' | 'cancelled'>(
  number: string, status: Status, decidedAt: Date, context: CommandContext,
) {
  await context.audit({
    action: `dining.reservation.${status}`,
    resourceType: 'dining_reservation', resourceId: number,
    payload: { result: status, decidedAt: decidedAt.toISOString() },
  });
  return { number, status };
}

export async function acceptDiningRequestHandler(input: z.infer<typeof decisionInput>, context: CommandContext) {
  const request = await requestAtStatus(input.number, 'pending', context);
  const commitment = await repository.commitCapacity(context.tx, request.id, context.now);
  await enqueueDiningNotification(context, request.id, 'accepted');
  return auditDecision(request.number, 'accepted', commitment.acceptedAt, context);
}

export async function rejectDiningRequestHandler(input: z.infer<typeof rejectInput>, context: CommandContext) {
  const request = await requestAtStatus(input.number, 'pending', context);
  const [decision] = await context.tx.update(diningRequests).set({
    rejectedAt: sql`pg_catalog.clock_timestamp()`, customerReason: input.reason || null,
  }).where(eq(diningRequests.id, request.id)).returning({ rejectedAt: diningRequests.rejectedAt });
  await enqueueDiningNotification(context, request.id, 'rejected');
  return auditDecision(request.number, 'rejected', decision!.rejectedAt!, context);
}

export async function cancelDiningReservationHandler(input: z.infer<typeof cancelInput>, context: CommandContext) {
  const request = await requestAtStatus(input.number, 'accepted', context);
  const commitment = await repository.cancelCapacity(context.tx, request.id, context.now);
  await context.tx.update(diningRequests).set({ customerReason: input.reason }).where(eq(diningRequests.id, request.id));
  await enqueueDiningNotification(context, request.id, 'cancelled');
  return auditDecision(request.number, 'cancelled', commitment.cancelledAt, context);
}
