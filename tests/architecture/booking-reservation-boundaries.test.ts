import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { createKeyring } from '@storeweave/crypto';
import { bindModuleCapability } from '@storeweave/kernel';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
  type BookingAvailabilityQuoteReservation,
} from '../../packages/booking/availability/src/quote-reservation';
import {
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  type BookingAvailabilityRoomNightOperations,
} from '../../packages/booking/availability/src/room-night-operations';
import { bookingReservationMigrations } from '../../packages/booking/reservation/src/migrations';
import {
  BOOKING_RESERVATION_ACCESS_CAPABILITY,
} from '../../packages/booking/reservation/src/access';
import { bookingReservationRetentionPolicySchema } from '../../packages/booking/reservation/src/retention';
import {
  bindBookingReservationAccess,
  createBookingReservationModule,
} from '../../packages/booking/reservation/src/module';
import type { BookingReservationPaymentProvider } from '../../packages/booking/reservation/src/payment-attempts';
import { createProcessBookingReservationRefundJob } from '../../packages/booking/reservation/src/jobs';

const paymentProvider: BookingReservationPaymentProvider = {
  id: 'booking-test-payment',
  paymentMethods: () => [{ code: 'deferred', label: 'Deferred test payment', timing: 'deferred' }],
  initiate: async () => ({
    status: 'failed', reason: 'provider_rejected', message: 'not invoked by package-boundary checks',
  }),
  refund: async () => ({ status: 'unsupported', message: 'not invoked by package-boundary checks' }),
};

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('Booking Reservation package boundary', () => {
  it('resolves the public package alias and registers the package in the build and lockfile', () => {
    const config = ts.readConfigFile(join(ROOT, 'tsconfig.base.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const consumer = resolve(ROOT, 'tests/architecture/booking-reservation-boundaries.test.ts');
    const resolved = ts.resolveModuleName('@storeweave/booking-reservation', consumer, parsed.options, ts.sys);

    expect(resolved.resolvedModule?.resolvedFileName).toBe(resolve(ROOT, 'packages/booking/reservation/src/index.ts'));
    expect(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).toContain(
      'COPY packages/booking/reservation/package.json packages/booking/reservation/',
    );
    expect(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).toMatch(/^  packages\/booking\/reservation:\s*\{\s*\}$/m);
  });

  it('owns Reservation data and consumes Availability only through its bound capability', () => {
    const binding = bindModuleCapability<BookingAvailabilityQuoteReservation>(
      'booking-availability',
      BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
      { revalidateAndReserve: async () => ({ kind: 'unavailable' }) },
    );
    const roomNightOperationsBinding = bindModuleCapability<BookingAvailabilityRoomNightOperations>(
      'booking-availability',
      BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
      {
        reserve: async () => ({ kind: 'reserved' }),
        release: async () => ({ kind: 'released' }),
      },
    );
    const accessBinding = bindBookingReservationAccess(createKeyring({
      activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 9).toString('base64url') }],
    }));
    const module = createBookingReservationModule(binding, roomNightOperationsBinding, accessBinding.value, {
      reservationPiiRetentionDays: 30,
    }, paymentProvider);
    const source = sourceFiles('packages/booking/reservation/src')
      .map(path => readFileSync(join(ROOT, path), 'utf8')).join('\n');
    const migration = bookingReservationMigrations.migrations.map(entry => entry.up).join('\n');
    const packageIndex = readFileSync(join(ROOT, 'packages/booking/reservation/src/index.ts'), 'utf8');

    expect(module.data?.owns).toEqual([
      'booking_reservation_reservations', 'booking_reservation_payment_attempts',
      'booking_reservation_refunds', 'booking_reservation_refund_invocations',
    ]);
    expect(module.dependencies?.required).toContainEqual({ name: 'booking-availability', versionRange: '^0.1.0' });
    expect(module.capabilities?.required).toContainEqual({
      from: 'booking-availability',
      capability: BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
      versionRange: '^0.1.0',
    });
    expect(module.capabilities?.required).toContainEqual({
      from: 'booking-availability',
      capability: BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
      versionRange: '^0.1.0',
    });
    expect(module.capabilities?.bound).toContain(binding);
    expect(module.capabilities?.bound).toContain(roomNightOperationsBinding);
    expect(module.capabilities?.provides).toContain(BOOKING_RESERVATION_ACCESS_CAPABILITY);
    expect(accessBinding).toMatchObject({ from: 'booking-reservation', capability: BOOKING_RESERVATION_ACCESS_CAPABILITY });
    expect(packageIndex).not.toMatch(/export \* from '\.\/(?:repository|schema)'/);
    expect(module.commands?.map(command => command.descriptor.name)).toEqual([
      'booking.reservation.create', 'booking.reservation.startPayment', 'booking.reservation.recordPaymentResult',
      'booking.reservation.recordVerifiedPaymentOutcome',
      'booking.reservation.cancelSelf', 'booking.reservation.cancelByOperator',
      'booking.reservation.requestRequiredPaymentRefund', 'booking.reservation.recordRefundInvocation',
      'booking.reservation.retryRefund', 'booking.reservation.reconcileRefunds',
      'booking.reservation.expire',
      'booking.reservation.claim', 'booking.reservation.updateManagedDetails', 'booking.reservation.anonymizeExpiredPii',
    ]);
    expect(module.queries?.map(query => query.descriptor.name)).toEqual([
      'booking.reservation.getPaymentAttemptForProcessing',
      'booking.reservation.getRefundForProcessing', 'booking.reservation.listRefunds',
      'booking.reservation.getOwned', 'booking.reservation.getManaged',
    ]);
    expect(module.jobs?.map(job => job.type)).toContain('booking.reservation.anonymize-expired-pii');
    expect(module.jobs?.find(job => job.type === 'booking.reservation.anonymize-expired-pii')?.schedule)
      .toEqual({ everyMs: 24 * 60 * 60 * 1000 });
    expect(module.jobs?.map(job => job.type)).toContain('booking.reservation.expire');
    expect(module.jobs?.map(job => job.type)).toContain('booking.reservation.process-payment');
    expect(module.jobs?.map(job => job.type)).toContain('booking.reservation.process-refund');
    expect(module.jobs?.map(job => job.type)).toContain('booking.reservation.reconcile-refunds');
    expect(bookingReservationMigrations.module).toBe('booking-reservation');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_reservation_reservations');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_reservation_payment_attempts');
    expect(migration).toMatch(/booking_reservation_payment_attempt_active_reservation_key[\s\S]*?status IN \('created', 'submitted', 'awaiting_payment'\)/i);
    expect(migration).toContain('winning_payment_attempt_id uuid');
    expect(migration).toContain('success_kind text');
    expect(migration).toContain('succeeded_at timestamptz');
    expect(migration).toContain('booking_reservation_payment_attempt_success_evidence_check');
    expect(migration).toContain('booking_reservation_payment_attempt_winning_reservation_key');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_reservation_refunds');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.booking_reservation_refund_invocations');
    expect(migration).toContain("reason IN ('late_payment', 'excess_payment', 'reservation_cancellation')");
    expect(migration).toContain('UNIQUE (payment_attempt_id)');
    expect(migration).toContain('booking_reservation_refund_attempt_reservation_fk');
    expect(migration).toContain('FOREIGN KEY (payment_attempt_id, reservation_id)');
    expect(migration).toContain('INSERT INTO public.booking_reservation_refunds');
    expect(migration).not.toContain('platform_jobs');
    expect(migration).toContain('booking_reservation_payment_attempt_id_reservation_key');
    expect(migration).toContain('booking_reservation_winning_payment_attempt_integrity');
    expect(migration).toContain('booking_reservation_winning_attempt_requires_pointer');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain("winning_payment_attempt_id IS NULL OR status IN ('confirmed', 'cancelled')");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS owner_account_id uuid/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS pii_anonymized_at timestamptz/);
    expect(migration).toContain('booking_reservation_anonymized_state_check');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS booking_reservation_retention_candidate_idx[\s\S]*?WHERE pii_anonymized_at IS NULL/i);
    expect(source).not.toMatch(/@storeweave\/(?:catalog|inventory|order|cart|customer|commerce)/);
    expect(source).not.toMatch(/@storeweave\/(?:identity|customer)/);
    expect(source).not.toMatch(/platform_users/);
    expect(source).not.toMatch(/@storeweave\/(?:payment|notification)/i);
    expect(source).not.toMatch(/@storeweave\/payment/i);
    expect(source).not.toMatch(/booking_availability_(?:room_nights|room_type_prices)/);
    expect(source).not.toMatch(/(?:fetch\(|axios|node:http|node:https)/);
    expect(migration).not.toMatch(/REFERENCES\s+public\.booking_availability_/i);
    expect(migration).not.toMatch(/REFERENCES\s+public\.platform_users/i);
  });

  it('requires a positive integer Reservation retention policy with no guessed default', () => {
    expect(bookingReservationRetentionPolicySchema.safeParse({ reservationPiiRetentionDays: 1 }).success).toBe(true);
    for (const invalid of [undefined, {}, { reservationPiiRetentionDays: 0 }, { reservationPiiRetentionDays: 1.5 },
      { reservationPiiRetentionDays: Number.MAX_SAFE_INTEGER + 1 }, { reservationPiiRetentionDays: 30, extra: true }]) {
      expect(bookingReservationRetentionPolicySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('does not invoke a refund provider when persisted refund evidence selects another provider', async () => {
    let calls = 0;
    const recorded: unknown[] = [];
    const handler = createProcessBookingReservationRefundJob({
      ...paymentProvider,
      refund: async () => { calls += 1; return { status: 'succeeded', providerRefundRef: 'should-not-happen' }; },
    });
    await expect(handler({ refundId: '00000000-0000-4000-8000-000000000000', generation: 1 }, {
      attempt: 1,
      executeQuery: async () => ({ kind: 'invoke', provider: 'another-provider', workerAttempt: 1, request: {
        providerRef: 'received-payment', amount: 100, currency: 'USD', reference: 'booking-refund:test',
      } }),
      executeCommand: async (_name: string, input: unknown) => { recorded.push(input); },
    } as never)).rejects.toThrow('requires provider another-provider');
    expect(calls).toBe(0);
    expect(recorded).toEqual([expect.objectContaining({
      result: { status: 'indeterminate', final: true, message: 'Configured refund provider does not match persisted refund evidence' },
    })]);
  });
});
