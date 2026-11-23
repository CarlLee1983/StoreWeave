import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { runMigrations } from '@storeweave/db';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiningReservationModule } from '../../packages/dining/reservation/src/module';
import { DiningReservationRepository } from '../../packages/dining/reservation/src/repository';
import { actorWith, createTestDatabase, testSecretProvider } from './helpers';

const manager = { ...actorWith(['dining-reservation:manage']), id: 'dining:operator' };
const visitor = { ...actorWith(['dining-reservation:request', 'dining-reservation:availability']), id: 'dining:visitor' };
const runtimes: Runtime[] = [];

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start(legacy = false) {
  const runtime = await createRuntime({
    release: { id: 'dining-decisions-test', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1, store: { id: 'dining-decisions-test', name: 'Dining Decisions Test' },
      database: { url: await createTestDatabase() }, logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 6).toString('base64url') }),
    logger: noopLogger, availableExtensions: {}, modules: [createDiningReservationModule({
      source: { limit: 10, windowMinutes: 60 }, recipient: { limit: 10, windowMinutes: 60 },
      piiRetentionDays: 30, identityKey: Buffer.alloc(32, 7),
    })],
  });
  runtimes.push(runtime);
  if (legacy) {
    await runMigrations(runtime.database.pool, runtime.migrations.map(set => set.module === 'dining-reservation'
      ? { ...set, migrations: set.migrations.filter(migration => migration.id < '0004_operator_decisions') }
      : set));
  } else {
    await runtime.migrate();
  }
  const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const command = <T = unknown>(name: string, input: unknown, idempotencyKey = randomUUID()) =>
    runtime.commands.execute<T>(`dining.reservation.${name}`, input, { actor: manager, idempotencyKey });
  await command('createVenue', { name: 'Dining', timezone: 'UTC' });
  await command('createTableType', { capacity: 4, count: 1 });
  await command('setDateOverride', { date, startTimes: ['12:00', '12:30', '13:30'] });
  const submit = (input: ReturnType<typeof requestInput>) => runtime.commands.execute<{ number: string; status: string }>(
    'dining.reservation.submitRequest', input, { actor: visitor });
  const get = (number: string) => runtime.queries.execute<{ status: string; decidedAt: Date | null }>(
    'dining.reservation.getRequest', { number }, { actor: manager });
  const openTimes = async (partySize = 3) => (await runtime.queries.execute<{ time: string }[]>(
    'dining.reservation.getOpenStarts', { date, partySize }, { actor: visitor })).map(row => row.time);
  return { runtime, date, command, submit, get, openTimes };
}

function requestInput(date: string, time = '12:00') {
  return {
    submissionKey: randomUUID(), sourceIdentity: 'trusted-source-identity-1',
    name: 'Ada Customer', phone: '+886 912 345 678', email: 'ada@example.test',
    note: 'High chair beside the window', partySize: 3, date, time,
  };
}

async function waitForLock(runtime: Runtime, queryPattern: string, expected: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const { rows } = await runtime.database.pool.query<{ waiting: number }>(
      `SELECT count(*)::integer AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE $1`, [queryPattern],
    );
    if (rows[0]!.waiting >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${expected} lock waiters matching ${queryPattern}`);
}

async function withLock(runtime: Runtime, lock: string, work: (release: () => Promise<void>) => Promise<void>) {
  const blocker = await runtime.database.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(lock);
    await work(async () => { await blocker.query('COMMIT'); });
  } finally {
    try { await blocker.query('ROLLBACK'); }
    finally { blocker.release(); }
  }
}

const lockVenue = 'SELECT id FROM dining_reservation_venues FOR UPDATE';

describe('Dining operator decisions', () => {
  it('accepts under the original number and preserves a private public submission replay', async () => {
    const { runtime, date, command, submit, get, openTimes } = await start();
    const input = requestInput(date);
    const initial = await submit(input);
    const idempotencyKey = randomUUID();
    const accepted = { number: initial.number, status: 'accepted' };

    expect(await command('acceptRequest', { number: initial.number }, idempotencyKey)).toEqual(accepted);
    expect(await command('acceptRequest', { number: initial.number }, idempotencyKey)).toEqual(accepted);
    expect(await get(initial.number)).toMatchObject(accepted);
    expect(await openTimes()).toEqual(['13:30']);

    expect(await submit(input)).toEqual(initial);
    await expect(runtime.queries.execute('dining.reservation.getRequest', { number: initial.number }, { actor: visitor }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a customer-visible cancellation reason and releases the accepted table', async () => {
    const { date, command, submit, get, openTimes } = await start();
    const { number } = await submit(requestInput(date));
    await command('acceptRequest', { number });

    for (const input of [{ number }, { number, reason: '   ' }]) {
      await expect(command('cancelReservation', input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await get(number)).toMatchObject({ status: 'accepted' });
    expect(await openTimes()).toEqual(['13:30']);

    const reason = 'The venue is closed for repairs';
    expect(await command('cancelReservation', { number, reason })).toEqual({ number, status: 'cancelled' });
    expect(await get(number)).toMatchObject({ status: 'cancelled', customerReason: reason, decidedAt: expect.any(Date) });
    expect(await openTimes()).toEqual(['12:00', '12:30', '13:30']);
  });

  it('rejects reasons PostgreSQL cannot store without mutating either decision', async () => {
    const { runtime, date, command, submit, get } = await start();
    const pending = await submit(requestInput(date));
    const accepted = await submit(requestInput(date));
    await command('acceptRequest', { number: accepted.number });

    for (const reason of ['Repairs\u0000today', 'Repairs\uD800today', 'Repairs\uDC00today']) {
      await expect(command('rejectRequest', { number: pending.number, reason }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(command('cancelReservation', { number: accepted.number, reason }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await get(pending.number)).toMatchObject({ status: 'pending', customerReason: null });
    expect(await get(accepted.number)).toMatchObject({ status: 'accepted', customerReason: null });
    expect(await runtime.audit.list(runtime.database.db, { resourceType: 'dining_reservation' })).toHaveLength(1);
    const reason = 'Repairs 🔧 today';
    await command('rejectRequest', { number: pending.number, reason });
    expect(await get(pending.number)).toMatchObject({ status: 'rejected', customerReason: reason });
  });

  it('permits only authorized decisions and audits actor, decision time, and result without contact or reason', async () => {
    const { runtime, date, command, submit, get, openTimes } = await start();
    const rejected = await submit(requestInput(date));
    const cancelled = await submit(requestInput(date));
    const acceptanceKey = randomUUID();
    await command('acceptRequest', { number: cancelled.number }, acceptanceKey);
    const acceptedAt = (await get(cancelled.number)).decidedAt!;
    const reason = 'Please call +886 912 345 678 about Ada Customer';

    for (const [name, input, idempotencyKey] of [
      ['acceptRequest', { number: rejected.number }, randomUUID()],
      ['acceptRequest', { number: cancelled.number }, acceptanceKey],
      ['rejectRequest', { number: rejected.number, reason }, randomUUID()],
      ['cancelReservation', { number: cancelled.number, reason }, randomUUID()],
    ] as const) {
      await expect(runtime.commands.execute(`dining.reservation.${name}`, input, { actor: visitor, idempotencyKey }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    const audit = () => runtime.audit.list(runtime.database.db, { resourceType: 'dining_reservation' });
    expect(await audit()).toHaveLength(1);
    expect(await get(rejected.number)).toMatchObject({ status: 'pending', customerReason: null });
    expect(await get(cancelled.number)).toMatchObject({ status: 'accepted', customerReason: null });
    expect(await openTimes()).toEqual(['13:30']);

    const rejectKey = randomUUID();
    await command('rejectRequest', { number: rejected.number, reason }, rejectKey);
    expect(await command('rejectRequest', { number: rejected.number, reason }, rejectKey))
      .toEqual({ number: rejected.number, status: 'rejected' });
    await command('cancelReservation', { number: cancelled.number, reason });
    const rejectedRequest = await get(rejected.number);
    const cancelledRequest = await get(cancelled.number);
    expect(rejectedRequest).toMatchObject({ status: 'rejected', customerReason: reason });
    expect(cancelledRequest).toMatchObject({ status: 'cancelled', customerReason: reason });

    const entries = await audit();
    expect(entries).toHaveLength(3);
    for (const [status, { number }, decidedAt] of [
      ['accepted', cancelled, acceptedAt],
      ['rejected', rejected, rejectedRequest.decidedAt!],
      ['cancelled', cancelled, cancelledRequest.decidedAt!],
    ] as const) {
      const entry = entries.find(row => row.action === `dining.reservation.${status}`);
      expect(entry).toMatchObject({ actorId: manager.id, actorType: 'user', resourceId: number,
        occurredAt: expect.any(Date) });
      expect(entry!.payload).toEqual({ result: status, decidedAt: decidedAt.toISOString() });
    }
  });

  it('serializes parallel acceptances for the last table and leaves the loser pending', async () => {
    const { runtime, date, command, submit, get, openTimes } = await start();
    const requests = await Promise.all([submit(requestInput(date)), submit(requestInput(date))]);

    await withLock(runtime, lockVenue, async release => {
      const outcomes = Promise.allSettled(requests.map(({ number }) => command('acceptRequest', { number })));
      await waitForLock(runtime, '%dining_reservation_venues%', 2);
      await release();
      const results = await outcomes;
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
      const winner = requests[winnerIndex]!;
      const loser = requests[1 - winnerIndex]!;
      expect(results[winnerIndex]).toEqual({ status: 'fulfilled', value: { number: winner.number, status: 'accepted' } });
      expect(results[1 - winnerIndex]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT', message: /capacity/ } });
      expect(await get(loser.number)).toMatchObject({ status: 'pending', decidedAt: null });
      expect(await openTimes()).toEqual(['13:30']);

      await expect(command('rejectRequest', { number: winner.number })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(command('cancelReservation', { number: loser.number, reason: 'Repairs' }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      await command('cancelReservation', { number: winner.number, reason: 'Repairs' });
      expect(await command('acceptRequest', { number: loser.number })).toEqual({ number: loser.number, status: 'accepted' });
    });
  });

  it('allows only one of concurrent acceptance and rejection of the same request', async () => {
    const { runtime, date, command, submit, get, openTimes } = await start();
    const { number } = await submit(requestInput(date));
    await withLock(runtime, lockVenue, async release => {
      const outcomes = Promise.allSettled([
        command('acceptRequest', { number }),
        command('rejectRequest', { number, reason: 'Private reason' }),
      ]);
      await waitForLock(runtime, '%dining_reservation_venues%', 2);
      await release();
      const results = await outcomes;
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const status = results[0]!.status === 'fulfilled' ? 'accepted' : 'rejected';
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
      expect(results.find(result => result.status === 'fulfilled')).toEqual({ status: 'fulfilled', value: { number, status } });
      expect(await get(number)).toMatchObject({ number, status, customerReason: status === 'accepted' ? null : 'Private reason' });
      expect(await openTimes()).toEqual(status === 'accepted' ? ['13:30'] : ['12:00', '12:30', '13:30']);
      expect(await runtime.audit.list(runtime.database.db, { resourceType: 'dining_reservation', resourceId: number }))
        .toMatchObject([{ action: `dining.reservation.${status}` }]);
    });
  });

  it('rechecks the saved full interval, smallest fitting type, and current schedule', async () => {
    const { date, command, submit, get, openTimes } = await start();
    await command('createTableType', { capacity: 5, count: 1 });
    const first = await submit(requestInput(date));
    const overlap = await submit(requestInput(date, '12:30'));
    const full = await submit(requestInput(date, '12:30'));
    const boundary = await submit(requestInput(date, '13:30'));
    await command('updateVenue', { name: 'Dining', timezone: 'UTC', occupancyMinutes: 30,
      minAdvanceMinutes: 60, maxAdvanceDays: 30 });

    await command('acceptRequest', { number: first.number });
    expect(await openTimes(5)).toEqual(['12:00', '12:30', '13:30']);
    await command('acceptRequest', { number: overlap.number });
    expect(await openTimes(5)).toEqual(['12:00']);
    await expect(command('acceptRequest', { number: full.number })).rejects.toMatchObject({ code: 'CONFLICT', message: /capacity/ });
    expect(await get(full.number)).toMatchObject({ status: 'pending', decidedAt: null });

    await command('setDateOverride', { date, startTimes: ['12:00', '12:30'] });
    const input = { number: boundary.number };
    const idempotencyKey = randomUUID();
    await expect(command('acceptRequest', input, idempotencyKey)).rejects.toMatchObject({ code: 'CONFLICT', message: /closed/ });
    expect(await get(boundary.number)).toMatchObject({ status: 'pending', decidedAt: null });
    await command('setDateOverride', { date, startTimes: ['12:00', '12:30', '13:30'] });
    expect(await command('acceptRequest', input, idempotencyKey)).toEqual({ ...input, status: 'accepted' });
  });

  it.each(['acceptRequest', 'cancelReservation'] as const)('refuses %s when the capacity write waits past the start', async operation => {
    const { runtime, date, command, submit, get } = await start();
    const { number } = await submit(requestInput(date));
    const cancellation = operation === 'cancelReservation';
    if (cancellation) await command('acceptRequest', { number });

    // Public submission requires a minute-aligned start with advance notice. Move this
    // fixture's instant near the database clock so an actual write can wait across it.
    const { rows: [timing] } = await runtime.database.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE dining_reservation_request_snapshots DISABLE TRIGGER dining_reservation_snapshot_immutable`);
      const result = await tx.execute<{ start_at: string }>(sql`
        WITH timing AS MATERIALIZED (SELECT pg_catalog.clock_timestamp() + interval '3 seconds' AS at)
        UPDATE dining_reservation_request_snapshots AS snapshot
        SET start_at = timing.at, end_at = timing.at + interval '90 minutes'
        FROM dining_reservation_requests AS request, timing
        WHERE request.id = snapshot.id AND request.request_number = ${number}
        RETURNING snapshot.start_at`);
      await tx.execute(sql`ALTER TABLE dining_reservation_request_snapshots ENABLE TRIGGER dining_reservation_snapshot_immutable`);
      return result;
    });
    const startAt = timing!.start_at;
    const before = await get(number);

    await withLock(runtime, 'LOCK TABLE dining_reservation_capacity_commitments IN SHARE MODE', async release => {
      const outcome = Promise.allSettled([command(operation, cancellation ? { number, reason: 'Repairs' } : { number })]);
      await waitForLock(runtime, '%dining_reservation_capacity_commitments%', 1);
      const { rows: [clock] } = await runtime.database.pool.query<{ before_start: boolean }>(
        'SELECT pg_catalog.clock_timestamp() < $1::timestamptz AS before_start', [startAt]);
      expect(clock!.before_start).toBe(true);
      await runtime.database.pool.query('SELECT pg_catalog.pg_sleep_until($1::timestamptz)', [startAt]);
      await release();
      expect(await outcome).toMatchObject([{ status: 'rejected', reason: { code: 'CONFLICT', message: /passed|started/ } }]);
    });

    expect(await get(number)).toEqual(before);
    const audit = () => runtime.audit.list(runtime.database.db, { resourceType: 'dining_reservation', resourceId: number });
    expect(await audit()).toHaveLength(cancellation ? 1 : 0);
    if (!cancellation) {
      expect(await command('rejectRequest', { number })).toEqual({ number, status: 'rejected' });
      expect(await get(number)).toMatchObject({ status: 'rejected', customerReason: null });
      expect((await get(number)).decidedAt!.getTime()).toBeGreaterThanOrEqual(new Date(startAt).getTime());
    }
  });

  it('reads prior capacity commitments and preserves anonymous replay after migration', async () => {
    const { runtime, date, submit, get } = await start(true);
    const repository = new DiningReservationRepository();
    const input = requestInput(date);
    const submissionHash = createHmac('sha256', Buffer.alloc(32, 7)).update('submission\0').update(input.submissionKey).digest('hex');
    const number = `DR-${randomBytes(10).toString('hex').toUpperCase()}`;
    const snapshot = await runtime.database.transaction(tx => repository.insertRequestSnapshot(tx, {
      date, time: input.time, partySize: input.partySize, createdAt: new Date(),
    }));
    await runtime.database.pool.query(`INSERT INTO dining_reservation_requests
      (id, submission_hash, request_number, contact_name, contact_phone, contact_email, note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [snapshot.id, submissionHash, number, input.name, input.phone, input.email, input.note, snapshot.createdAt]);
    const commitment = await runtime.database.transaction(tx => repository.commitCapacity(tx, snapshot.id, new Date()));

    expect(await runtime.migrate()).toEqual(['dining-reservation/0004_operator_decisions']);
    expect(await get(number)).toMatchObject({ status: 'accepted', customerReason: null, decidedAt: commitment.acceptedAt });
    expect(await submit(input)).toEqual({ number, status: 'pending' });
  });
});
