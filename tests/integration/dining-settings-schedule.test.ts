import { randomUUID } from 'node:crypto';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiningReservationModule } from '../../packages/dining/reservation/src/module';
import { DiningReservationRepository } from '../../packages/dining/reservation/src/repository';
import { actorWith, createTestDatabase, testSecretProvider } from './helpers';

const MANAGER = actorWith(['dining-reservation:manage']);
const READER = actorWith(['dining-reservation:read']);
const runtimes: Runtime[] = [];
const repository = new DiningReservationRepository();

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function start() {
  const runtime = await createRuntime({
    release: { id: 'dining-settings-test', version: '1.0.0', buildManifestChecksum: `sha256:${'5'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({
      version: 1, store: { id: 'dining-settings-test', name: 'Dining Settings Test' },
      database: { url: await createTestDatabase() }, logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 5).toString('base64url') }),
    logger: noopLogger, availableExtensions: {}, modules: [createDiningReservationModule()],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

async function command<T>(runtime: Runtime, name: string, input: unknown): Promise<T> {
  return runtime.commands.execute<T>(name, input, { actor: MANAGER, idempotencyKey: randomUUID() });
}

async function createVenue(runtime: Runtime, timezone = 'Asia/Taipei') {
  return command<{ id: string }>(runtime, 'dining.reservation.createVenue', { name: '示範餐廳', timezone });
}

describe('Dining settings and schedule', () => {
  it('persists a single venue, table capacities, schedule overrides, and contact-free audit', async () => {
    const runtime = await start();
    await createVenue(runtime);
    const first = await command<{ id: string }>(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 3 });
    await expect(command(runtime, 'dining.reservation.createTableType', { capacity: 4, count: 1 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await command(runtime, 'dining.reservation.setWeeklyStarts', { weekday: 0, startTimes: ['18:00', '23:30'] });
    await command(runtime, 'dining.reservation.setDateOverride', { date: '2026-10-04', startTimes: [] });
    await command(runtime, 'dining.reservation.setDateOverride', { date: '2026-10-11', startTimes: ['19:00'] });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(future);
    const datePart = (type: string) => dateParts.find(part => part.type === type)!.value;
    const liveDate = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
    await command(runtime, 'dining.reservation.setDateOverride', { date: liveDate, startTimes: ['19:00'] });

    expect(await runtime.queries.execute('dining.reservation.getVenue', {}, { actor: READER }))
      .toMatchObject({ name: '示範餐廳', timezone: 'Asia/Taipei', occupancyMinutes: 90,
        minAdvanceMinutes: 60, maxAdvanceDays: 30 });
    expect(await runtime.queries.execute('dining.reservation.listTableTypes', {}, { actor: READER }))
      .toMatchObject([{ id: first.id, capacity: 4, count: 3, active: true }]);
    expect(await runtime.queries.execute('dining.reservation.listDateOverrides', {}, { actor: READER }))
      .toEqual(expect.arrayContaining([{ date: '2026-10-04', startTimes: [] }, { date: '2026-10-11', startTimes: ['19:00'] }]));
    await expect(command(runtime, 'dining.reservation.updateVenue', {
      name: '示範餐廳', timezone: 'GMT', occupancyMinutes: 90,
      minAdvanceMinutes: 60, maxAdvanceDays: 30,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const open = await runtime.queries.execute<{ time: string }[]>('dining.reservation.getOpenStarts',
      { date: liveDate }, { actor: READER });
    expect(open).toMatchObject([{ time: '19:00' }]);
    await expect(runtime.queries.execute('dining.reservation.getVenue', {}, { actor: MANAGER }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    const audit = await runtime.database.pool.query<{
      actor_id: string; occurred_at: Date; payload: { result: string }; action: string;
    }>("SELECT actor_id, occurred_at, payload, action FROM platform_audit_log WHERE action LIKE 'dining.%'");
    expect(audit.rows).toHaveLength(6);
    for (const row of audit.rows) {
      expect(row.actor_id).toBe(MANAGER.id);
      expect(row.occurred_at).toBeInstanceOf(Date);
      expect(row.payload).toEqual({ result: 'applied' });
      expect(JSON.stringify(row)).not.toMatch(/email|phone|customer/i);
    }
  });

  it('locks timezone after the first request and preserves request duration and window snapshots', async () => {
    const runtime = await start();
    await createVenue(runtime);
    await command(runtime, 'dining.reservation.setWeeklyStarts', { weekday: 0, startTimes: ['23:30'] });
    const request = await runtime.database.transaction(tx => repository.insertRequestSnapshot(tx, {
      date: '2026-10-04', time: '23:30', partySize: 3, createdAt: new Date('2026-10-01T00:00:00Z'),
    }));
    expect(request.startAt.toISOString()).toBe('2026-10-04T15:30:00.000Z');
    expect(request.endAt.toISOString()).toBe('2026-10-04T17:00:00.000Z');
    await expect(command(runtime, 'dining.reservation.updateVenue', {
      name: '示範餐廳', timezone: 'Asia/Tokyo', occupancyMinutes: 90,
      minAdvanceMinutes: 60, maxAdvanceDays: 30,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await command(runtime, 'dining.reservation.updateVenue', {
      name: '示範餐廳', timezone: 'Asia/Taipei', occupancyMinutes: 120,
      minAdvanceMinutes: 120, maxAdvanceDays: 14,
    });
    const snapshot = await runtime.database.pool.query(
      'SELECT start_at, end_at, start_date::text AS start_date, start_time, timezone, party_size, occupancy_minutes, min_advance_minutes, max_advance_days FROM dining_reservation_request_snapshots WHERE id = $1',
      [request.id],
    );
    expect(snapshot.rows).toEqual([{ start_at: request.startAt, end_at: request.endAt,
      start_date: '2026-10-04', start_time: '23:30', timezone: 'Asia/Taipei', party_size: 3,
      occupancy_minutes: 90, min_advance_minutes: 60, max_advance_days: 30 }]);
    const futureRequest = await runtime.database.transaction(tx => repository.insertRequestSnapshot(tx, {
      date: '2026-10-11', time: '23:30', partySize: 2, createdAt: new Date('2026-10-01T00:00:00Z'),
    }));
    expect(futureRequest.occupancyMinutes).toBe(120);
    expect(futureRequest.minAdvanceMinutes).toBe(120);
    expect(futureRequest.maxAdvanceDays).toBe(14);
    await expect(runtime.database.pool.query('UPDATE dining_reservation_venues SET timezone = $1', ['UTC']))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runtime.database.pool.query('UPDATE dining_reservation_request_snapshots SET occupancy_minutes = 120'))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('serializes the first request with a concurrent timezone edit', async () => {
    const runtime = await start();
    await createVenue(runtime);
    await command(runtime, 'dining.reservation.setWeeklyStarts', { weekday: 0, startTimes: ['18:00'] });
    let inserted!: () => void;
    let release!: () => void;
    const insertedSignal = new Promise<void>(resolve => { inserted = resolve; });
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const firstRequest = runtime.database.transaction(async tx => {
      await repository.insertRequestSnapshot(tx, {
        date: '2026-10-04', time: '18:00', partySize: 2, createdAt: new Date('2026-10-01T00:00:00Z'),
      });
      inserted();
      await releaseSignal;
    });
    await insertedSignal;
    const timezoneEdit = command(runtime, 'dining.reservation.updateVenue', {
      name: '示範餐廳', timezone: 'Asia/Tokyo', occupancyMinutes: 90,
      minAdvanceMinutes: 60, maxAdvanceDays: 30,
    });
    try {
      const early = await Promise.race([timezoneEdit.then(() => 'updated', () => 'rejected'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
      expect(early).toBe('blocked');
    } finally {
      release();
    }
    await firstRequest;
    await expect(timezoneEdit).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
