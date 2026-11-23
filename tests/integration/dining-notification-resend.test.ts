import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diningMailFixture } from './fixtures/dining-mail';
import { actorWith } from './helpers';

const manager = { ...actorWith(['dining-reservation:manage']), id: 'user:dining-operator' };
const mailOperator = actorWith(['mail:send', 'notifications:read', 'notifications:resend']);
const visitor = actorWith(['dining-reservation:request', 'dining-reservation:availability']);
const startDiningMail = diningMailFixture('dining-notification-resend-test');

async function start() {
  const { runtime, smtp, worker } = await startDiningMail();
  const settle = () => worker.drain();
  const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const command = (name: string, input: unknown) =>
    runtime.commands.execute(`dining.reservation.${name}`, input, { actor: manager, idempotencyKey: randomUUID() });
  await command('createVenue', { name: 'Dining', timezone: 'UTC' });
  await command('createTableType', { capacity: 4, count: 1 });
  await command('setDateOverride', { date, startTimes: ['12:00', '12:30', '13:30'] });
  const submit = (time = '12:00') => runtime.commands.execute<{ number: string }>('dining.reservation.submitRequest', {
    submissionKey: randomUUID(), sourceIdentity: 'trusted-source-identity-1',
    name: 'Ada Customer', phone: '+886 912 345 678', email: 'ada@example.test', partySize: 3, date, time,
  }, { actor: visitor });
  const get = (number: string) => runtime.queries.execute('dining.reservation.getRequest', { number }, { actor: manager });
  const list = (number: string, actor = manager) =>
    runtime.queries.execute<{ items: Array<{ event: string; id: string; status: string; attempts: number }> }>(
      'dining.reservation.listRequestNotifications', { number }, { actor });
  const openTimes = async () => (await runtime.queries.execute<Array<{ time: string }>>(
    'dining.reservation.getOpenStarts', { date, partySize: 3 }, { actor: visitor })).map(row => row.time);
  return { runtime, smtp, settle, command, submit, get, list, openTimes };
}

describe('Dining notification resend', () => {
  it('requires explicit authorized resend of an unknown acceptance, retaining state, capacity, and delivery evidence', async () => {
    const { runtime, smtp, settle, command, submit, get, list, openTimes } = await start();
    const { number } = await submit();
    await settle();
    expect(await list(number)).toMatchObject({ items: [{ event: 'received', status: 'sent', attempts: 1 }] });
    expect(await openTimes()).toContain('12:00');

    smtp.outcome = 'unknown';
    await command('acceptRequest', { number });
    await settle();
    expect(await get(number)).toMatchObject({ status: 'accepted' });
    expect(await openTimes()).toEqual(['13:30']);
    const delivery = (await list(number)).items.find(item => item.event === 'accepted')!;
    expect(delivery).toMatchObject({ status: 'unknown', attempts: 1 });

    const baseEvidence = async () => {
      const { items } = await runtime.queries.execute<{ items: Array<{ id: string; reference: string; status: string; attempts: number }> }>(
        'platform.notifications.listDeliveries', { channel: 'email' }, { actor: mailOperator });
      return items.find(item => item.id === delivery.id)!;
    };
    const mailEvidence = async () => runtime.mail.diagnosticByReference(`notification:${(await baseEvidence()).reference}:email`);
    const audit = () => runtime.audit.list(runtime.database.db, { resourceType: 'notification_delivery', resourceId: delivery.id });
    expect(await mailEvidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    smtp.outcome = 'accept';
    await runtime.notifications.deliver(delivery.id);
    expect(smtp.recipients.length).toBe(2);

    const operationId = randomUUID();
    const input = { number, event: 'accepted', deliveryId: delivery.id, operationId, expectedAttempts: 1, acknowledgeDuplicateRisk: true };
    const resend = (actor = manager, overrides: Partial<typeof input> = {}, idempotencyKey = operationId) =>
      runtime.commands.execute('dining.reservation.resendRequestEmail', { ...input, ...overrides }, { actor, idempotencyKey });
    await expect(list(number, mailOperator)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resend(mailOperator)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.commands.execute('platform.notifications.resendEmail',
      { deliveryId: delivery.id, operationId, expectedAttempts: 1, acknowledgeDuplicateRisk: true },
      { actor: mailOperator, idempotencyKey: operationId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resend(manager, { acknowledgeDuplicateRisk: false })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(resend(manager, { expectedAttempts: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(resend(manager, { event: 'received' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await audit()).toEqual([]);
    expect(smtp.recipients.length).toBe(2);

    const receipt = { deliveryId: delivery.id, operationId };
    expect(await resend()).toEqual(receipt);
    await expect(resend({ ...manager, type: 'service' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await resend()).toEqual(receipt);
    await settle();
    expect(await resend()).toEqual(receipt);
    expect(await resend(manager, {}, randomUUID())).toEqual(receipt);
    await expect(resend(manager, { expectedAttempts: 2 }, randomUUID())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(smtp.recipients.length).toBe(3);
    expect((await list(number)).items.find(item => item.id === delivery.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await baseEvidence()).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await mailEvidence()).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(await audit()).toMatchObject([{
      action: 'notification.email_resent', actorId: manager.id, actorType: 'user', occurredAt: expect.any(Date),
      payload: { operationId, previousStatus: 'unknown', status: 'sent', attempts: 2, acknowledgeDuplicateRisk: true,
        attemptedAt: expect.any(String) },
    }]);
    expect(await get(number)).toMatchObject({ status: 'accepted' });
    expect(await openTimes()).toEqual(['13:30']);
  });

  it('preserves the request after a failed receipt and releases capacity after a failed cancellation', async () => {
    const { runtime, smtp, settle, command, submit, get, list, openTimes } = await start();
    smtp.outcome = 'reject';
    const { number } = await submit();
    await settle();
    expect(await get(number)).toMatchObject({ status: 'pending' });
    expect(await list(number)).toMatchObject({ items: [{ event: 'received', status: 'failed', attempts: 1 }] });
    expect(await openTimes()).toContain('12:00');

    smtp.outcome = 'accept';
    await command('acceptRequest', { number });
    await settle();
    expect(await openTimes()).toEqual(['13:30']);

    smtp.outcome = 'reject';
    await command('cancelReservation', { number, reason: 'Dining room is closed today' });
    await settle();
    expect(await get(number)).toMatchObject({ status: 'cancelled' });
    expect(await openTimes()).toEqual(['12:00', '12:30', '13:30']);
    const cancelled = (await list(number)).items.find(item => item.event === 'cancelled')!;
    expect(cancelled).toMatchObject({ status: 'failed', attempts: 1 });

    smtp.outcome = 'accept';
    const operationId = randomUUID();
    const input = { number, event: 'cancelled', deliveryId: cancelled.id, operationId, expectedAttempts: 1 };
    await expect(runtime.commands.execute('dining.reservation.resendRequestEmail', input, {
      actor: manager, idempotencyKey: operationId,
    })).resolves.toEqual({ deliveryId: cancelled.id, operationId });
    await settle();
    expect(smtp.recipients.length).toBe(4);
    expect((await list(number)).items.find(item => item.event === 'cancelled')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await runtime.audit.list(runtime.database.db, { resourceType: 'notification_delivery', resourceId: cancelled.id }))
      .toMatchObject([{ actorId: manager.id, action: 'notification.email_resent', payload: {
        previousStatus: 'failed', status: 'sent', attempts: 2, acknowledgeDuplicateRisk: false,
      } }]);
    expect(await get(number)).toMatchObject({ status: 'cancelled' });
    expect(await openTimes()).toEqual(['12:00', '12:30', '13:30']);
  });

  it('recognizes the earlier receipt reference and keeps unrelated Base resend available', async () => {
    const { runtime, smtp, settle, submit, list } = await start();
    const { number } = await submit();
    const { rows } = await runtime.database.pool.query<{ id: string }>(
      'SELECT id FROM dining_reservation_requests WHERE request_number = $1', [number],
    );
    // SW166 created the receipt inside submission. Model that stored notification
    // using the old reference and immutable template before the new job runs.
    const copy = 'We received your dining request {number}. This is not a confirmed reservation.';
    const previous = await runtime.notifications.dispatch({
      reference: `dining-reservation:received:${rows[0]!.id}`, channels: ['email'],
      recipient: { email: 'ada@example.test', name: 'Ada Customer' },
      template: { id: 'dining.reservation.received', version: 1, email: {
        subject: 'We received your dining request', text: copy, html: `<p>${copy}</p>`,
      } },
      variables: { number },
    });
    const other = await runtime.notifications.dispatch({
      reference: 'operator-test:standalone', channels: ['email'],
      recipient: { email: 'operator@example.test' },
      template: { id: 'operator-test', version: 1, email: {
        subject: 'Standalone notice', text: 'Standalone notice', html: '<p>Standalone notice</p>',
      } },
    });
    smtp.outcome = 'reject';
    await settle();
    const deliveryId = previous.deliveries[0]!.id;
    const otherDeliveryId = other.deliveries[0]!.id;
    expect(smtp.recipients.length).toBe(2);
    expect(await list(number)).toMatchObject({ items: [{ event: 'received', id: deliveryId, status: 'failed', attempts: 1 }] });

    const baseResend = (deliveryId: string) => {
      const operationId = randomUUID();
      return runtime.commands.execute('platform.notifications.resendEmail', { deliveryId, operationId, expectedAttempts: 1 },
        { actor: mailOperator, idempotencyKey: operationId });
    };
    await expect(baseResend(deliveryId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(baseResend(otherDeliveryId)).resolves.toMatchObject({ deliveryId: otherDeliveryId });
    const operationId = randomUUID();
    await expect(runtime.commands.execute('dining.reservation.resendRequestEmail', {
      number, event: 'received', deliveryId, operationId, expectedAttempts: 1,
    }, { actor: manager, idempotencyKey: operationId })).resolves.toEqual({ deliveryId, operationId });
    smtp.outcome = 'accept';
    await settle();
    expect(smtp.recipients.length).toBe(4);
    expect(await list(number)).toMatchObject({ items: [{ event: 'received', id: deliveryId, status: 'sent', attempts: 2 }] });
    expect(await runtime.mail.diagnosticByReference('notification:operator-test:standalone:email'))
      .toMatchObject({ status: 'accepted', attempts: 2 });
  });
});
