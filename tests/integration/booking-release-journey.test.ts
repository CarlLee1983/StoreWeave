import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Worker, type Runtime } from '@storeweave/kernel';
import { bootstrapRelease } from '../../packages/platform/release/src/bootstrap';
import { serverProjection } from '../../packages/releases/booking/src/server';
import { createReleaseServer } from '../../apps/api/src/release-server';

const signingSecret = Buffer.alloc(32, 45).toString('base64url');
const previousSigningSecret = process.env.SW_SIGNING_KEY_TEST;
const operator = { id: 'test:booking-release-operator', type: 'user' as const,
  displayName: 'Booking Release Operator', permissions: ['*'] };
let container: StartedPostgreSqlContainer;
let directory: string;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof createReleaseServer>>;
let roomTypeId: string;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function roomNights(checkIn: string, checkOut: string): Promise<number[]> {
  const result = await runtime.database.pool.query<{ reserved_units: number }>(`
    SELECT reserved_units FROM booking_availability_room_nights
    WHERE room_type_id = $1 AND local_date >= $2 AND local_date < $3 ORDER BY local_date
  `, [roomTypeId, checkIn, checkOut]);
  return result.rows.map(row => row.reserved_units);
}

async function runWorkerUntil(predicate: () => Promise<boolean>): Promise<void> {
  const worker = new Worker(runtime, { workerId: `booking-release-${randomUUID().slice(0, 8)}`, concurrency: 1 });
  for (let index = 0; index < 20; index += 1) {
    await worker.relayOutbox();
    await worker.runJobs();
    if (await predicate()) return;
  }
  throw new Error('Booking Release worker did not reach the expected state');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_release_journey').withUsername('booking').withPassword('booking').start();
  directory = mkdtempSync(join(tmpdir(), 'storeweave-booking-release-'));
  const configPath = join(directory, 'booking.yaml');
  writeFileSync(configPath, JSON.stringify({
    version: 1, store: { id: 'booking-release-journey', name: 'Booking Release Journey', currency: 'USD' },
    database: { url: container.getConnectionUri() },
    booking: { reservationPiiRetentionDays: 365 },
    theme: { id: 'booking-default' },
    extensions: [{ id: 'mock-payment', config: { autoApprove: true } }],
    logging: { level: 'error' },
    storage: { localRoot: join(directory, 'storage') },
    paths: { dataDir: join(directory, 'data'), backupDir: join(directory, 'backups') },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  process.env.SW_SIGNING_KEY_TEST = signingSecret;
  const boot = await bootstrapRelease(serverProjection.release, { configPath, loggerName: 'booking-release-journey' });
  runtime = boot.runtime;
  await runtime.migrate();
  expect(boot.theme?.id).toBe('booking-default');
  app = await createReleaseServer({ runtime, theme: boot.theme, httpAdapter: serverProjection.httpAdapter,
    release: { version: serverProjection.release.version, configPath: boot.loaded.sourcePath } });
  await runtime.commands.execute('booking.property.create', {
    name: 'Release Journey Hotel', address: { countryCode: 'US', postalCode: '90210',
      administrativeArea: 'California', locality: 'Los Angeles', addressLine1: 'Ocean 1', addressLine2: null },
    timezone: 'America/Los_Angeles', currency: 'USD', checkInTime: '15:00', checkOutTime: '11:00',
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  }, { actor: operator, idempotencyKey: randomUUID() });
  const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
    code: 'release', name: 'Release Room', description: null, maxOccupancyPerUnit: 4,
    beds: [{ type: 'queen', count: 1 }], amenities: [], minimumStayNights: 1,
    maximumStayNights: null, mediaAssetId: null,
  }, { actor: operator, idempotencyKey: randomUUID() });
  roomTypeId = room.id;
  await runtime.commands.execute('booking.availability.setBaseNightlyPrice', {
    roomTypeId, baseNightlyPriceMinor: 12_345,
  }, { actor: operator, idempotencyKey: randomUUID() });
  const checkIn = addDays(localDate(new Date()), 7);
  await runtime.commands.execute('booking.availability.updateRoomNightRange', {
    roomTypeId, startLocalDate: checkIn, endLocalDateExclusive: addDays(checkIn, 3), sellableUnits: 1,
  }, { actor: operator, idempotencyKey: randomUUID() });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  await container?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSigningSecret === undefined) delete process.env.SW_SIGNING_KEY_TEST;
  else process.env.SW_SIGNING_KEY_TEST = previousSigningSecret;
});

describe('Booking Release composed journey', () => {
  it('searches, quotes, reserves, confirms with mock payment, cancels and refunds through the selected Release', async () => {
    const checkInLocalDate = addDays(localDate(new Date()), 7);
    const checkOutLocalDate = addDays(checkInLocalDate, 2);
    const stay = { roomTypeId, checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 };
    const search = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes/search',
      payload: { checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 } });
    expect(search.statusCode, search.body).toBe(201);
    expect(JSON.stringify(search.json())).toContain(roomTypeId);
    const quote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: stay });
    expect(quote.statusCode, quote.body).toBe(201);
    const fingerprint = quote.json().data.quote.fingerprint as string;
    const created = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations',
      headers: { 'idempotency-key': randomUUID() }, payload: {
        quote: { ...stay, fingerprint },
        booker: { name: 'Release Booker', email: 'release.booker@example.test', phone: '+1 555 0199' },
        primaryGuestName: 'Release Guest', accommodationNotes: 'Release journey arrival',
      } });
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string; status: string }; checkoutCredential: string;
    };
    expect(reservation.status).toBe('pending_payment');
    expect(await roomNights(checkInLocalDate, checkOutLocalDate)).toEqual([1, 1]);

    const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'mock' } });
    expect(payment.statusCode, payment.body).toBe(202);
    await runWorkerUntil(async () => {
      const state = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
      return state.rows[0]?.status === 'confirmed';
    });
    const winner = await runtime.database.pool.query<{ status: string; winning_payment_attempt_id: string }>(
      'SELECT status, winning_payment_attempt_id FROM booking_reservation_reservations WHERE id = $1', [reservation.id]);
    expect(winner.rows).toEqual([{ status: 'confirmed', winning_payment_attempt_id: payment.json().data.attemptId }]);
    expect(await roomNights(checkInLocalDate, checkOutLocalDate)).toEqual([1, 1]);

    const cancellation = await runtime.commands.execute<{ reservationId: string; cancelled: boolean; refund: { id: string } }>(
      'booking.reservation.cancelByOperator', { reservationId: reservation.id,
        refundAmountMinor: quote.json().data.quote.totalMinor, reason: 'Release journey cancellation' },
      { actor: operator, idempotencyKey: randomUUID() });
    expect(cancellation).toMatchObject({ reservationId: reservation.id, cancelled: true,
      refund: { id: expect.any(String) } });
    expect(await roomNights(checkInLocalDate, checkOutLocalDate)).toEqual([0, 0]);
    await runWorkerUntil(async () => {
      const result = await runtime.database.pool.query<{ status: string }>(
        'SELECT status FROM booking_reservation_refunds WHERE id = $1', [cancellation.refund.id]);
      return result.rows[0]?.status === 'succeeded';
    });
    const evidence = await runtime.database.pool.query<{ status: string; provider_refund_ref: string; outcome: string }>(`
      SELECT f.status, f.provider_refund_ref, i.outcome
      FROM booking_reservation_refunds f
      JOIN booking_reservation_refund_invocations i ON i.refund_id = f.id
      WHERE f.id = $1`, [cancellation.refund.id]);
    expect(evidence.rows).toMatchObject([{
      status: 'succeeded', provider_refund_ref: expect.stringMatching(/^mock_refund_/), outcome: 'succeeded',
    }]);
  }, 180_000);
});
