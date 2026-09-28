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
const repository = new DiningReservationRepository();
const runtimes: Runtime[] = [];
const submittedAt = new Date();
function localDate(at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const part = (kind: string) => parts.find(value => value.type === kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const date = localDate(new Date(Date.now() + 7 * 24 * 60 * 60_000));
const nextDate = localDate(new Date(Date.now() + 8 * 24 * 60 * 60_000));

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start() {
  const runtime = await createRuntime({
    release: { id: 'dining-capacity-test', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1, store: { id: 'dining-capacity-test', name: 'Dining Capacity Test' },
      database: { url: await createTestDatabase() }, logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 6).toString('base64url') }),
    logger: noopLogger, availableExtensions: {}, modules: [createDiningReservationModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  await command(runtime, 'dining.reservation.createVenue', { name: '示範餐廳', timezone: 'Asia/Taipei' });
  return runtime;
}

async function command<T = unknown>(runtime: Runtime, name: string, input: unknown): Promise<T> {
  return runtime.commands.execute<T>(name, input, { actor: manager, idempotencyKey: randomUUID() });
}

async function request(runtime: Runtime, date: string, time: string, partySize: number) {
  return runtime.database.transaction(tx => repository.insertRequestSnapshot(tx, {
    date, time, partySize, createdAt: submittedAt,
  }));
}

async function accept(runtime: Runtime, requestId: string) {
  return runtime.database.transaction(tx => repository.commitCapacity(tx, requestId, submittedAt));
}

async function waitForVenueLockWait(runtime: Runtime, expected = 1) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runtime.database.pool.query<{ waiting: number }>(
      `SELECT count(*)::integer AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%dining_reservation_venues%'`,
    );
    if (result.rows[0]!.waiting >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${expected} Dining venue lock waiters`);
}

describe('Dining capacity commitment', () => {
  it('uses half-open intervals, selects the smallest available type, and keeps historical snapshots', async () => {
    const runtime = await start();
    await command(runtime, 'dining.reservation.setDateOverride', {
      date, startTimes: ['18:00', '18:30', '19:00', '19:30', '23:30'],
    });
    await command(runtime, 'dining.reservation.setDateOverride', { date: nextDate, startTimes: [] });
    const four = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 1 });
    const five = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 5, count: 1 });
    const first = await request(runtime, date, '18:00', 3);
    const second = await request(runtime, date, '18:30', 3);
    const third = await request(runtime, date, '19:00', 3);
    const next = await request(runtime, date, '19:30', 3);
    const midnight = await request(runtime, date, '23:30', 5);
    expect((await accept(runtime, first.id)).tableTypeId).toBe(four.id);
    expect((await accept(runtime, second.id)).tableTypeId).toBe(five.id);
    await expect(accept(runtime, third.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await accept(runtime, next.id)).tableTypeId).toBe(four.id);
    expect((await accept(runtime, midnight.id)).tableTypeId).toBe(five.id);
    expect(localDate(midnight.endAt)).toBe(nextDate);
    expect(midnight.endAt.getTime() - midnight.startAt.getTime()).toBe(90 * 60_000);

    await runtime.database.transaction(tx => repository.cancelCapacity(tx, second.id, submittedAt));
    expect((await accept(runtime, third.id)).tableTypeId).toBe(five.id);
    await command(runtime, 'dining.reservation.updateVenue', {
      name: '示範餐廳', timezone: 'Asia/Taipei', occupancyMinutes: 120,
      minAdvanceMinutes: 60, maxAdvanceDays: 30,
    });
    const later = await request(runtime, date, '23:30', 4);
    expect(later.occupancyMinutes).toBe(120);
    expect(midnight.occupancyMinutes).toBe(90);
    await command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: five.id, capacity: 6, count: 1, active: true,
    });
    const saved = await runtime.database.pool.query<{ table_type_capacity: number; end_at: Date }>(
      `SELECT c.table_type_capacity, r.end_at FROM dining_reservation_capacity_commitments c
       JOIN dining_reservation_request_snapshots r ON r.id = c.request_id WHERE c.request_id = $1`, [midnight.id],
    );
    expect(saved.rows).toEqual([{ table_type_capacity: 5, end_at: midnight.endAt }]);
  });

  it('blocks invalid supply edits, but closure leaves accepted commitments in place', async () => {
    const runtime = await start();
    await command(runtime, 'dining.reservation.setDateOverride', { date, startTimes: ['18:00', '19:00'] });
    const type = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 2 });
    const first = await request(runtime, date, '18:00', 4);
    const second = await request(runtime, date, '19:00', 3);
    const pending = await request(runtime, date, '19:00', 2);
    await accept(runtime, first.id);
    await accept(runtime, second.id);
    await expect(command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: type.id, capacity: 4, count: 1, active: true,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: type.id, capacity: 3, count: 2, active: true,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: type.id, capacity: 4, count: 0, active: false,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await command(runtime, 'dining.reservation.setDateOverride', { date, startTimes: [] });
    await expect(accept(runtime, pending.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const commitments = await runtime.database.pool.query('SELECT request_id FROM dining_reservation_capacity_commitments WHERE cancelled_at IS NULL');
    expect(commitments.rows).toHaveLength(2);
  });

  it('serializes competing acceptances and settings edits on the venue row', async () => {
    const runtime = await start();
    await command(runtime, 'dining.reservation.setDateOverride', { date, startTimes: ['18:00'] });
    const type = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 1 });
    const first = await request(runtime, date, '18:00', 2);
    const second = await request(runtime, date, '18:00', 2);
    let release!: () => void;
    let locked!: () => void;
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const lockSignal = new Promise<void>(resolve => { locked = resolve; });
    const firstAcceptance = runtime.database.transaction(async tx => {
      await repository.commitCapacity(tx, first.id, submittedAt);
      locked();
      await releaseSignal;
    });
    await lockSignal;
    const secondAcceptance = accept(runtime, second.id);
    const reduction = command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: type.id, capacity: 4, count: 0, active: false,
    });
    try {
      await waitForVenueLockWait(runtime, 2);
    } finally { release(); }
    await firstAcceptance;
    await expect(secondAcceptance).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reduction).rejects.toMatchObject({ code: 'CONFLICT' });

    let releaseCancellation!: () => void;
    let cancelled!: () => void;
    const cancellationRelease = new Promise<void>(resolve => { releaseCancellation = resolve; });
    const cancellationSignal = new Promise<void>(resolve => { cancelled = resolve; });
    const cancellation = runtime.database.transaction(async tx => {
      await repository.cancelCapacity(tx, first.id, submittedAt);
      cancelled();
      await cancellationRelease;
    });
    await cancellationSignal;
    const reductionAfterCancellation = command(runtime, 'dining.reservation.updateTableType', {
      tableTypeId: type.id, capacity: 4, count: 0, active: false,
    });
    try {
      await waitForVenueLockWait(runtime);
    } finally { releaseCancellation(); }
    await cancellation;
    await expect(reductionAfterCancellation).resolves.toMatchObject({ count: 0, active: false });
  });

  it('uses peak simultaneous occupancy for overlapping chains', async () => {
    const runtime = await start();
    await command(runtime, 'dining.reservation.setDateOverride', {
      date, startTimes: ['18:00', '19:00', '19:30'],
    });
    const type = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 2 });
    await accept(runtime, (await request(runtime, date, '18:00', 2)).id);
    await accept(runtime, (await request(runtime, date, '19:30', 2)).id);
    expect((await accept(runtime, (await request(runtime, date, '19:00', 2)).id)).tableTypeId).toBe(type.id);
  });

  it('serializes closure against acceptance and permits supply edits after an interval ends', async () => {
    const runtime = await start();
    await command(runtime, 'dining.reservation.setDateOverride', { date, startTimes: ['18:00'] });
    const type = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 1 });
    const accepted = await request(runtime, date, '18:00', 2);
    const pending = await request(runtime, date, '18:00', 2);
    let release!: () => void;
    let locked!: () => void;
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const lockSignal = new Promise<void>(resolve => { locked = resolve; });
    const acceptance = runtime.database.transaction(async tx => {
      await repository.commitCapacity(tx, accepted.id, submittedAt);
      locked();
      await releaseSignal;
    });
    await lockSignal;
    const closure = command(runtime, 'dining.reservation.setDateOverride', { date, startTimes: [] });
    try {
      await waitForVenueLockWait(runtime);
    } finally { release(); }
    await acceptance;
    await closure;
    await expect(accept(runtime, pending.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const remaining = await runtime.database.pool.query(
      'SELECT request_id FROM dining_reservation_capacity_commitments WHERE cancelled_at IS NULL',
    );
    expect(remaining.rows).toEqual([{ request_id: accepted.id }]);

    const pastRequestId = randomUUID();
    const venue = await repository.getSettings(runtime.database.db);
    await runtime.database.pool.query(
      `INSERT INTO dining_reservation_request_snapshots
       (id, venue_id, start_at, end_at, start_date, start_time, timezone, party_size,
        occupancy_minutes, min_advance_minutes, max_advance_days, created_at)
       VALUES ($1, $2, '2020-01-01T10:00:00Z', '2020-01-01T11:30:00Z', '2020-01-01',
        '18:00', 'Asia/Taipei', 4, 90, 60, 30, '2019-12-20T00:00:00Z')`,
      [pastRequestId, venue!.id],
    );
    await runtime.database.pool.query(
      `INSERT INTO dining_reservation_capacity_commitments
       (request_id, table_type_id, table_type_capacity, accepted_at)
       VALUES ($1, $2, 4, '2019-12-20T00:00:00Z')`, [pastRequestId, type.id],
    );
    await expect(runtime.database.transaction(tx => repository.cancelCapacity(tx, pastRequestId, submittedAt)))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await runtime.database.transaction(tx => repository.cancelCapacity(tx, accepted.id, submittedAt));
    const disabled = await command<{ count: number; active: boolean }>(runtime,
      'dining.reservation.updateTableType', { tableTypeId: type.id, capacity: 1, count: 0, active: false });
    expect(disabled).toMatchObject({ count: 0, active: false });
  });
});
