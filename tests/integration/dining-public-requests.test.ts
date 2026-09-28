import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiningReservationModule } from '../../packages/dining/reservation/src/module';
import { DiningReservationRepository } from '../../packages/dining/reservation/src/repository';
import { actorWith, createTestDatabase, testSecretProvider } from './helpers';

const manager = actorWith(['dining-reservation:manage']);
const reader = actorWith(['dining-reservation:availability']);
const visitor = actorWith(['dining-reservation:request']);
const runtimes: Runtime[] = [];

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start(sourceLimit = 3, recipientLimit = 3) {
  const runtime = await createRuntime({
    release: { id: 'dining-public-test', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1, store: { id: 'dining-public-test', name: 'Dining Public Test' },
      database: { url: await createTestDatabase() }, logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 6).toString('base64url') }),
    logger: noopLogger, availableExtensions: {}, modules: [createDiningReservationModule({
      source: { limit: sourceLimit, windowMinutes: 60 },
      recipient: { limit: recipientLimit, windowMinutes: 60 },
      piiRetentionDays: 30, identityKey: Buffer.alloc(32, 7),
    })],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const command = (name: string, input: unknown) => runtime.commands.execute(name, input,
    { actor: manager, idempotencyKey: randomUUID() });
  await command('dining.reservation.createVenue', { name: 'Dining', timezone: 'UTC' });
  await command('dining.reservation.createTableType', { capacity: 4, count: 1 });
  await command('dining.reservation.setDateOverride', { date, startTimes: ['12:00', '13:30'] });
  return { runtime, date };
}

function input(date: string, overrides: Record<string, unknown> = {}) {
  return { submissionKey: randomUUID(), sourceIdentity: 'trusted-source-identity-1',
    name: 'Ada', phone: '+886 912 345 678', email: 'ada@example.test', partySize: 3,
    date, time: '12:00', note: 'High chair for infant; please call first.  <verbatim>', ...overrides };
}

async function submit(runtime: Runtime, request: unknown) {
  return runtime.commands.execute<{ number: string; status: string }>('dining.reservation.submitRequest',
    request, { actor: visitor });
}

async function counts(runtime: Runtime) {
  const { rows: [row] } = await runtime.database.pool.query<{
    requests: string; notifications: string; rates: string; platform_replays: string;
  }>(`SELECT
    (SELECT count(*) FROM dining_reservation_requests)::text AS requests,
    (SELECT count(*) FROM platform_notifications WHERE template_id = 'dining.reservation.received')::text AS notifications,
    (SELECT count(*) FROM dining_reservation_request_rate_events)::text AS rates,
    (SELECT count(*) FROM platform_idempotency WHERE command_name = 'dining.reservation.submitRequest')::text AS platform_replays`);
  return row!;
}

describe('Dining public requests', () => {
  it('returns only fitting available starts and accepts concurrent replay once', async () => {
    const { runtime, date } = await start();
    const starts = (partySize: number) => runtime.queries.execute<{ time: string }[]>(
      'dining.reservation.getOpenStarts', { date, partySize }, { actor: reader });
    expect((await starts(3)).map(row => row.time)).toEqual(['12:00', '13:30']);
    expect(await starts(5)).toEqual([]);
    const request = input(date);
    const [first, replay] = await Promise.all([submit(runtime, request), submit(runtime, request)]);
    expect(replay).toEqual(first);
    expect(first.number).toMatch(/^DR-[0-9A-F]{20}$/);
    expect(await counts(runtime)).toEqual({ requests: '1', notifications: '1', rates: '1', platform_replays: '0' });
    const details = await runtime.queries.execute<{ note: string; partySize: number; status: string }>(
      'dining.reservation.getRequest', { number: first.number }, { actor: manager });
    expect(details).toMatchObject({ note: request.note, partySize: 3, status: 'pending' });
    await expect(runtime.queries.execute('dining.reservation.getRequest', { number: first.number }, { actor: visitor }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const second = await submit(runtime, input(date));
    expect(second.number).not.toBe(first.number);
    expect((await starts(3)).map(row => row.time)).toEqual(['12:00', '13:30']);
    const repository = new DiningReservationRepository();
    await runtime.database.transaction(async tx => {
      const snapshot = await repository.insertRequestSnapshot(tx, {
        date, time: '12:00', partySize: 3, createdAt: new Date(),
      });
      await repository.commitCapacity(tx, snapshot.id, new Date());
    });
    expect((await starts(3)).map(row => row.time)).toEqual(['13:30']);
    await expect(submit(runtime, input(date, { sourceIdentity: 'trusted-source-identity-3' })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await counts(runtime)).requests).toBe('2');
  });

  it('rejects invalid and unavailable requests without persistence or receipt', async () => {
    const { runtime, date } = await start();
    for (const request of [
      input(date, { phone: 'bad' }), input(date, { partySize: 0 }), input(date, { partySize: 5 }),
      input(date, { time: '14:00' }), input(date, { date: '2020-01-01' }),
    ]) await expect(submit(runtime, request)).rejects.toBeDefined();
    expect(await counts(runtime)).toEqual({ requests: '0', notifications: '0', rates: '0', platform_replays: '0' });
  });

  it('enforces source and recipient limits independently and expires hashed rate evidence', async () => {
    const { runtime, date } = await start(1, 2);
    await submit(runtime, input(date));
    await expect(submit(runtime, input(date, { email: 'other@example.test' })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await submit(runtime, input(date, { sourceIdentity: 'trusted-source-identity-2' }));
    await expect(submit(runtime, input(date, { sourceIdentity: 'trusted-source-identity-3' })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await counts(runtime)).toEqual({ requests: '2', notifications: '2', rates: '2', platform_replays: '0' });
    const evidence = await runtime.database.pool.query('SELECT source_hash, recipient_hash FROM dining_reservation_request_rate_events');
    expect(JSON.stringify(evidence.rows)).not.toContain('ada@example.test');
    expect(JSON.stringify(evidence.rows)).not.toContain('trusted-source-identity');
    await runtime.database.pool.query('UPDATE dining_reservation_request_rate_events SET expires_at = now() - interval \'1 second\'');
    const result = await runtime.commands.execute<{ deleted: number }>('dining.reservation.expireRateEvents', {},
      { actor: { id: 'system', type: 'system', permissions: ['*'] } });
    expect(result.deleted).toBe(2);
    expect((await counts(runtime)).rates).toBe('0');
  });
});
