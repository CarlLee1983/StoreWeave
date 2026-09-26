import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Worker, type Runtime } from '@storeweave/kernel';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
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
    booking: { reservationPiiRetentionDays: 365, operatorAlertEmail: 'operator@example.test' },
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
  it('serves only previews referenced by active rooms through the composed storefront', async () => {
    const index = await runtime.database.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'booking_property_room_types' AND indexname = 'booking_property_room_types_active_media_idx'",
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]!.indexdef).toContain('(media_asset_id)');
    expect(index.rows[0]!.indexdef).toContain("WHERE (status = 'active'::text)");
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const asset = await runtime.media.upload({ stream: Readable.from(png), originalName: 'room.png', contentType: 'image/png', ownerActorId: operator.id });
    await runtime.media.process({ assetId: asset.id, generation: asset.generation }, { signal: new AbortController().signal });
    const facts = {
      name: 'Photo Room', description: null, maxOccupancyPerUnit: 2, beds: [{ type: 'queen', count: 1 }],
      amenities: [], minimumStayNights: 1, maximumStayNights: null, mediaAssetId: asset.id,
    };
    const preview = `/booking/media/${asset.id}/preview`;
    const opened = vi.spyOn(runtime.media, 'openPreview');
    let photoRoomId: string | undefined;
    try {
      for (const id of ['invalid', randomUUID(), asset.id]) {
        const denied = await app.inject(`/booking/media/${id}/preview`);
        expect(denied.statusCode, denied.body).toBe(404);
      }
      expect(opened).not.toHaveBeenCalled();

      const room = await runtime.commands.execute<{ id: string }>('booking.property.createRoomType', {
        code: 'photo-room', ...facts,
      }, { actor: operator, idempotencyKey: randomUUID() });
      photoRoomId = room.id;
      const page = await app.inject(`/rooms/${room.id}`);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.body).toContain(`src="${preview}"`);
      const response = await app.inject(preview);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
      expect(response.rawPayload.subarray(8, 12).toString()).toBe('WEBP');
      expect(opened).toHaveBeenCalledTimes(1);
      expect((await app.inject(`/api/v1/media/${asset.id}/preview`)).statusCode).not.toBe(200);

      await runtime.commands.execute('booking.property.updateRoomType', {
        roomTypeId: room.id, ...facts, status: 'disabled',
      }, { actor: operator, idempotencyKey: randomUUID() });
      opened.mockClear();
      expect((await app.inject(preview)).statusCode).toBe(404);
      expect(opened).not.toHaveBeenCalled();

      await runtime.commands.execute('booking.property.updateRoomType', {
        roomTypeId: room.id, ...facts, status: 'active', mediaAssetId: null,
      }, { actor: operator, idempotencyKey: randomUUID() });
      expect((await app.inject(preview)).statusCode).toBe(404);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      if (photoRoomId) await runtime.commands.execute('booking.property.updateRoomType', {
        roomTypeId: photoRoomId, ...facts, status: 'disabled', mediaAssetId: null,
      }, { actor: operator, idempotencyKey: randomUUID() });
    }
  });

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

  it('routes a Late Payment alert to the configured operator mailbox through the selected Release', async () => {
    const checkInLocalDate = addDays(localDate(new Date()), 7);
    const checkOutLocalDate = addDays(checkInLocalDate, 2);
    const stay = { roomTypeId, checkInLocalDate, checkOutLocalDate, adults: 2, children: 0, roomCount: 1 };
    const quote = await app.inject({ method: 'POST', url: '/api/v1/booking/quotes', payload: stay });
    const created = await app.inject({ method: 'POST', url: '/api/v1/booking/reservations',
      headers: { 'idempotency-key': randomUUID() }, payload: {
        quote: { ...stay, fingerprint: quote.json().data.quote.fingerprint },
        booker: { name: 'Late Booker', email: 'late.booker@example.test', phone: '+1 555 0199' },
        primaryGuestName: 'Late Guest', accommodationNotes: 'Late fixture',
      } });
    expect(created.statusCode, created.body).toBe(201);
    const { reservation, checkoutCredential } = created.json().data as {
      reservation: { id: string }; checkoutCredential: string;
    };
    const payment = await app.inject({ method: 'POST', url: `/api/v1/booking/reservations/${reservation.id}/payments`,
      headers: { 'x-booking-checkout-credential': checkoutCredential, 'idempotency-key': randomUUID() },
      payload: { method: 'mock' } });
    expect(payment.statusCode, payment.body).toBe(202);
    const attemptId = payment.json().data.attemptId as string;
    await runtime.commands.execute('booking.reservation.cancelByOperator', {
      reservationId: reservation.id, refundAmountMinor: 0, reason: 'Late Release fixture',
    }, { actor: operator, idempotencyKey: randomUUID() });
    await runtime.commands.execute('booking.reservation.recordPaymentResult', {
      attemptId, provider: 'mock-payment', result: { status: 'confirmed', providerRef: `late-release:${attemptId}` },
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await runWorkerUntil(async () => {
      const result = await runtime.database.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM booking_reservation_notification_links
        WHERE payment_attempt_id = $1 AND kind = 'late-payment' AND mapping_status = 'requested'`, [attemptId]);
      return result.rows[0]?.count === '1';
    });
    const alert = await runtime.database.pool.query<{ recipient_email: string; variables: Record<string, unknown>; refund_id: string }>(`
      SELECT n.recipient_email, n.variables, l.refund_id
      FROM booking_reservation_notification_links l
      JOIN platform_notifications n ON n.reference = l.reference
      WHERE l.payment_attempt_id = $1 AND l.kind = 'late-payment'`, [attemptId]);
    expect(alert.rows).toEqual([expect.objectContaining({ recipient_email: 'operator@example.test' })]);
    expect(alert.rows[0]!.variables).toEqual({
      reservationId: reservation.id, paymentAttemptId: attemptId, refundId: alert.rows[0]!.refund_id,
    });
    expect(JSON.stringify(alert.rows[0])).not.toContain('late.booker@example.test');
    expect(await roomNights(checkInLocalDate, checkOutLocalDate)).toEqual([0, 0]);
  }, 180_000);
});
