import { randomUUID } from 'node:crypto';
import type { Runtime } from '@storeweave/kernel';
import { describe, expect, it } from 'vitest';
import { diningMailFixture } from './fixtures/dining-mail';
import { actorWith } from './helpers';

const manager = actorWith(['dining-reservation:manage']);
const visitor = actorWith(['dining-reservation:request', 'dining-reservation:availability']);
const startDiningMail = diningMailFixture('dining-notification-test');

async function start() {
  const { runtime, smtp, worker } = await startDiningMail();
  const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const command = <T = unknown>(name: string, input: unknown, idempotencyKey = randomUUID()) =>
    runtime.commands.execute<T>(`dining.reservation.${name}`, input, { actor: manager, idempotencyKey });
  await command('createVenue', { name: 'Dining', timezone: 'Asia/Taipei' });
  const tableType = await command<{ id: string }>('createTableType', { capacity: 37, count: 1 });
  await command('setDateOverride', { date, startTimes: ['07:30'] });
  const submit = (email: string, submissionKey = randomUUID()) => runtime.commands.execute<{ number: string; status: string }>(
    'dining.reservation.submitRequest', {
      submissionKey, sourceIdentity: 'trusted-source-identity',
      name: 'Ada Customer', phone: '+886 912 345 678', email, partySize: 3, date, time: '07:30',
      note: 'Internal request note',
    }, { actor: visitor });
  const get = (number: string) => runtime.queries.execute(
    'dining.reservation.getRequest', { number }, { actor: manager });
  const openTimes = async () => (await runtime.queries.execute<{ time: string }[]>(
    'dining.reservation.getOpenStarts', { date, partySize: 3 }, { actor: visitor })).map(row => row.time);
  return {
    runtime, date, command, submit, worker, smtp, get, openTimes, tableType,
  };
}

async function messages(runtime: Runtime) {
  const { rows } = await runtime.database.pool.query<{
    template_id: string; reference: string; text_body: string; html: string; status: string;
  }>('SELECT template_id, reference, text_body, html, status FROM platform_mail_messages ORDER BY template_id');
  return rows;
}

describe('Dining lifecycle email', () => {
  it('maps each decision and sends it once using the original number and customer facts', async () => {
    const { runtime, date, command, submit, worker, smtp, tableType } = await start();
    const email = 'ada@example.test';
    const submissionKey = randomUUID();
    const { number } = await submit(email, submissionKey);
    const acceptKey = randomUUID();
    expect(await command('acceptRequest', { number }, acceptKey)).toEqual({ number, status: 'accepted' });
    const reason = 'Kitchen closed <unexpectedly>';
    await command('cancelReservation', { number, reason });
    const declined = await submit('declined@example.test');
    await command('rejectRequest', { number: declined.number });
    const declinedWithReason = await submit('declined-with-reason@example.test');
    const rejectionReason = 'Private event & no alternate seating';
    await command('rejectRequest', { number: declinedWithReason.number, reason: rejectionReason });

    expect((await worker.drain()).jobsFailed).toBe(0);
    expect(await submit(email, submissionKey)).toEqual({ number, status: 'pending' });
    expect(await command('acceptRequest', { number }, acceptKey)).toEqual({ number, status: 'accepted' });
    const { rows: [materialization] } = await runtime.database.pool.query<{ id: string }>(
      "SELECT id FROM platform_jobs WHERE type = 'dining.reservation.materialize-notification' AND payload->>'event' = 'accepted'");
    await runtime.jobs.requeue(runtime.database.db, materialization!.id);
    expect((await worker.drain()).jobsFailed).toBe(0);

    const delivered = await messages(runtime);
    expect(delivered.map(row => [row.template_id, row.status])).toEqual([
      ['dining.reservation.accepted', 'accepted'],
      ['dining.reservation.cancelled', 'accepted'],
      ['dining.reservation.received', 'accepted'],
      ['dining.reservation.received', 'accepted'],
      ['dining.reservation.received', 'accepted'],
      ['dining.reservation.rejected', 'accepted'],
      ['dining.reservation.rejected', 'accepted'],
    ]);
    const [accepted, cancelled, ...other] = delivered;
    for (const part of [accepted!.text_body, accepted!.html]) {
      expect(part).toContain(number);
      expect(part).toContain(date);
      expect(part).toContain('07:30');
      expect(part).toMatch(/party of 3/i);
      expect(part).not.toMatch(/\b37\b|table type|Internal request note/i);
      expect(part).not.toContain(tableType.id);
    }
    expect(cancelled!.text_body).toContain(number);
    expect(cancelled!.text_body).toContain(reason);
    expect(cancelled!.html).toContain('Kitchen closed &lt;unexpectedly&gt;');
    expect(other.some(row => row.template_id === 'dining.reservation.received' && row.text_body.includes(number))).toBe(true);
    const rejections = other.filter(row => row.template_id === 'dining.reservation.rejected');
    const genericRejection = rejections.find(row => row.text_body.includes(declined.number));
    expect(genericRejection?.text_body).toContain('We could not accept your dining request');
    expect(genericRejection?.text_body).not.toContain('Reason:');
    const detailedRejection = rejections.find(row => row.text_body.includes(declinedWithReason.number));
    expect(detailedRejection?.text_body).toContain(rejectionReason);
    expect(detailedRejection?.html).toContain('Private event &amp; no alternate seating');
    expect(new Set(delivered.map(row => row.reference))).toHaveProperty('size', 7);
    for (const row of delivered) {
      expect(row.reference).toMatch(/^notification:dining-reservation:(received|accepted|rejected|cancelled):[0-9a-f-]{36}:email$/);
    }
    expect(smtp.recipients.sort()).toEqual([
      email, email, email,
      'declined-with-reason@example.test', 'declined-with-reason@example.test',
      'declined@example.test', 'declined@example.test',
    ]);
  });

  it('commits the request and capacity while unavailable notification writes retry separately', async () => {
    const { runtime, command, submit, worker, get, openTimes, smtp } = await start();
    // Block the real Base Notification INSERT, after Dining has committed.
    await runtime.database.pool.query(`
      CREATE FUNCTION reject_dining_notification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Test Notification insert outage'; END;
      $$;
      CREATE TRIGGER reject_dining_notification BEFORE INSERT ON platform_notifications
      FOR EACH ROW EXECUTE FUNCTION reject_dining_notification()
    `);
    const { number } = await submit('ada@example.test');
    expect(await get(number)).toMatchObject({ number, status: 'pending' });
    expect(await command('acceptRequest', { number })).toEqual({ number, status: 'accepted' });
    expect(await openTimes()).toEqual([]);
    expect((await worker.drain()).jobsFailed).toBe(2);
    expect(await get(number)).toMatchObject({ number, status: 'accepted' });
    expect(await messages(runtime)).toEqual([]);
    expect(smtp.recipients).toEqual([]);

    const { rows } = await runtime.database.pool.query<{ payload: unknown; status: string; last_error: string }>(`
      SELECT payload, status, last_error FROM platform_jobs
      WHERE type = 'dining.reservation.materialize-notification' ORDER BY payload->>'event'
    `);
    expect(rows.map(({ last_error, ...job }) => {
      expect(last_error).not.toMatch(/ada@example\.test|Ada Customer/i);
      return job;
    })).toEqual([
      { payload: { event: 'accepted', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }, status: 'pending' },
      { payload: { event: 'received', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }, status: 'pending' },
    ]);
    await runtime.database.pool.query(`
      DROP TRIGGER reject_dining_notification ON platform_notifications;
      UPDATE platform_jobs SET run_at = now() WHERE type = 'dining.reservation.materialize-notification'
    `);
    expect((await worker.drain()).jobsFailed).toBe(0);
    expect((await messages(runtime)).map(row => row.template_id))
      .toEqual(['dining.reservation.accepted', 'dining.reservation.received']);
    expect(smtp.recipients).toEqual(['ada@example.test', 'ada@example.test']);
    expect(await get(number)).toMatchObject({ number, status: 'accepted' });
    expect(await openTimes()).toEqual([]);
  });

  it('keeps failed acceptance and unknown cancellation delivery independent of Dining state', async () => {
    const { runtime, command, submit, worker, get, openTimes, smtp } = await start();
    const email = 'ada@example.test';
    const { number } = await submit(email);
    expect((await worker.drain()).jobsFailed).toBe(0);
    smtp.outcome = 'reject';
    await command('acceptRequest', { number });
    await worker.drain();
    expect(await get(number)).toMatchObject({ number, status: 'accepted' });
    expect(await openTimes()).toEqual([]);
    let delivered = await messages(runtime);
    const failed = delivered.find(row => row.template_id === 'dining.reservation.accepted');
    expect(failed?.status).toBe('rejected');
    const failedReference = failed!.reference.slice('notification:'.length, -':email'.length);
    expect((await runtime.notifications.evidenceByReference([failedReference])).get(failedReference))
      .toMatchObject([{ status: 'failed', attempts: 1 }]);

    smtp.outcome = 'unknown';
    const reason = 'Kitchen closed unexpectedly';
    await command('cancelReservation', { number, reason });
    await worker.drain();
    expect(await get(number)).toMatchObject({ number, status: 'cancelled', customerReason: reason });
    expect(await openTimes()).toEqual(['07:30']);
    delivered = await messages(runtime);
    const uncertain = delivered.find(row => row.template_id === 'dining.reservation.cancelled');
    expect(uncertain?.status).toBe('unknown');
    const unknownReference = uncertain!.reference.slice('notification:'.length, -':email'.length);
    const evidence = async () => (await runtime.notifications.evidenceByReference([unknownReference])).get(unknownReference);
    const items = await evidence();
    expect(items).toMatchObject([{ status: 'unknown', attempts: 1 }]);
    const { rows: [deliveryJob] } = await runtime.database.pool.query<{ id: string }>(`
      SELECT id FROM platform_jobs WHERE type = 'platform.notification.deliver' AND payload->>'deliveryId' = $1
    `, [items![0]!.id]);
    const smtpAttempts = smtp.recipients.length;
    smtp.outcome = 'accept';
    await runtime.jobs.requeue(runtime.database.db, deliveryJob!.id);
    await worker.drain();
    expect(await evidence()).toEqual(items);
    expect(smtp.recipients).toHaveLength(smtpAttempts);
    expect(await openTimes()).toEqual(['07:30']);
  });
});
