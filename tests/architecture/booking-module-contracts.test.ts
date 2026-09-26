import { describe, expect, it } from 'vitest';
import { actorHolds } from '@storeweave/authorization';
import { noopLogger, SYSTEM_ACTOR } from '@storeweave/contracts';
import { ProviderRegistry, runExtensionContractChecks } from '@storeweave/extension-sdk';
import { runModuleContractChecks } from '@storeweave/release/module-contract';
import { bookingReleaseDefinition } from '../../packages/releases/booking/src/definition';
import { release } from '../../packages/releases/booking/src/runtime';

const bookingModules = ['booking-property', 'booking-availability', 'booking-reservation'] as const;
const internalPermissions = ['booking-reservation:system-write', 'booking-reservation:retention-write'] as const;

function selectedModules() {
  const config = release.config.schema.parse(release.manifestConfig);
  return release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
}

describe('Booking selected module contracts', () => {
  it('selects the complete Booking product module set with its Base modules', () => {
    const selected = selectedModules().map(module => module.name);
    expect(selected).toEqual(bookingReleaseDefinition.manifest.selected.modules);
    expect(selected.filter(name => name.startsWith('booking-'))).toEqual(bookingModules);
  });

  it.each(bookingModules.slice(0, 2))('passes the release-scoped module contract checks for %s', moduleName => {
    const checks = runModuleContractChecks(release, moduleName);
    expect(checks.length).toBeGreaterThan(1);
    expect(checks.filter(check => !check.ok)).toEqual([]);
  });

  it('records exactly the two internal-only Reservation diagnostics', () => {
    const checks = runModuleContractChecks(release, 'booking-reservation');
    expect(checks.length).toBeGreaterThan(1);
    expect(checks.filter(check => !check.ok)).toEqual([
      { name: 'declared permissions are granted to a release role', ok: false,
        message: 'booking-reservation:system-write, booking-reservation:retention-write' },
      { name: 'command / query inputs are a plain object the HTTP bridge can pick keys from', ok: false,
        message: 'booking.reservation.materializeNotification' },
    ]);
  });

  it('keeps internal permissions out of named human-role grants while the system actor holds them', () => {
    const explicit = Object.values(release.roles).flatMap(role => role.permissions);
    for (const permission of internalPermissions) {
      expect(explicit).not.toContain(permission);
      expect(actorHolds(SYSTEM_ACTOR, permission)).toBe(true);
      for (const [roleName, role] of Object.entries(release.roles)) {
        if (roleName === 'admin') continue; // Admin's wildcard is an intentional operator grant.
        expect(actorHolds({ id: `test:${roleName}`, type: 'user', permissions: role.permissions }, permission)).toBe(false);
      }
    }
    expect(release.roles.admin?.permissions).toContain('*');
  });

  it('rejects extra input keys in every actual notification materialization variant', () => {
    const module = selectedModules().find(candidate => candidate.name === 'booking-reservation');
    const descriptor = module?.commands?.find(command => command.descriptor.name === 'booking.reservation.materializeNotification')?.descriptor;
    expect(descriptor).toBeDefined();
    const common = {
      eventId: '00000000-0000-4000-8000-000000000001',
      reservationId: '00000000-0000-4000-8000-000000000002',
    };
    const paymentAttemptId = '00000000-0000-4000-8000-000000000003';
    const variants = [
      { ...common, kind: 'confirmed', paymentAttemptId, confirmedAt: '2026-01-01T00:00:00.000Z' },
      { ...common, kind: 'cancelled', cancelledAt: '2026-01-01T00:00:00.000Z' },
      { ...common, kind: 'payment-expiring', paymentAttemptId, expiresAt: '2026-01-01T00:00:00.000Z' },
      { ...common, kind: 'late-payment', paymentAttemptId, refundId: '00000000-0000-4000-8000-000000000004' },
    ];
    for (const variant of variants) {
      expect(descriptor!.input.safeParse(variant).success, variant.kind).toBe(true);
      expect(descriptor!.input.safeParse({ ...variant, unexpected: true }).success, variant.kind).toBe(false);
    }
  });
});

describe('Booking selected Extension contract', () => {
  it('runs the SDK checks on the selected mock-payment Extension', async () => {
    const selected = bookingReleaseDefinition.manifest.selected.extensions;
    expect(selected).toEqual(['mock-payment']);
    expect(Object.keys(release.availableExtensions)).toEqual([...selected]);

    for (const id of selected) {
      const extension = release.availableExtensions[id];
      expect(extension).toBeDefined();
      expect(extension.manifest.id).toBe(id);
      expect(extension.manifest.subscribedEvents).toEqual([]);
      expect(extension.manifest.permissions).toEqual([]);
      const checks = await runExtensionContractChecks(extension, {
        knownEvents: [],
        knownPermissions: [],
        sampleConfig: { autoApprove: true, declineAboveCents: 0, latencyMs: 0 },
        invalidConfig: { autoApprove: 'yes' },
      });
      expect(checks.length).toBeGreaterThan(5);
      expect(checks.filter(check => !check.ok)).toEqual([]);
    }
  });
});
