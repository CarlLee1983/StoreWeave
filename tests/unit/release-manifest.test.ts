import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { catalogDigest, validateWorkOwnership } from '@storeweave/db';
import { noopLogger } from '@storeweave/contracts';
import { ProviderRegistry, defineExtension } from '@storeweave/extension-sdk';
import { bindModuleCapability, type RuntimeSecurity } from '@storeweave/kernel';
import {
  BOOKING_PROPERTY_READ_CAPABILITY, composeBookingAvailabilityRuntime,
} from '@storeweave/booking-availability';
import { bookingQuoteFingerprintForKey, bookingQuoteFingerprintTerms } from '@storeweave/booking-availability';
import { BookingAvailabilityRepository } from '@storeweave/booking-availability';
import { createKeyring } from '@storeweave/crypto';
import { release as base } from '../../packages/releases/base/src/runtime';
import { release as commerce } from '../../packages/releases/commerce/src/runtime';
import { bootstrapRelease } from '../../packages/platform/release/src/bootstrap';
import { buildReleaseManifest, buildReleasePermissionCatalog, projectReleaseManifest } from '../../packages/platform/release/src/runtime';

const databaseConstructed = vi.hoisted(() => vi.fn());
vi.mock('@storeweave/db', async original => ({
  ...await original<typeof import('@storeweave/db')>(),
  Database: class { constructor() { databaseConstructed(); throw new Error('Database constructed'); } },
}));
const directories: string[] = [];
afterEach(() => {
  databaseConstructed.mockClear();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('release build manifest', () => {
  it('contains SQL-free module pins and available extension jobs without running setup', () => {
    const setup = vi.fn(() => { throw new Error('setup must not run'); });
    const extension = defineExtension({ manifest: {
      id: 'manifest-probe', name: 'Probe', version: '1.0.0', platformVersion: '^1.0.0',
      configuration: z.object({}), permissions: [], subscribedEvents: [], registeredCommands: [],
      registeredQueries: [], registeredProviders: [], registeredJobs: ['ext.manifest-probe.run'],
    }, setup });
    const manifest = buildReleaseManifest({ ...base, availableExtensions: { 'manifest-probe': extension } });
    expect(manifest.modules.map(module => module.id)).toEqual(['content', 'platform', 'platform-auth', 'platform-cache', 'platform-identity', 'platform-mail', 'platform-media', 'platform-notifications', 'platform-ops', 'platform-site', 'platform-storage']);
    expect(manifest.modules.find(module => module.id === 'platform')?.dataRelations)
      .toContain('platform_job_quarantine');
    expect(manifest.modules.find(module => module.id === 'platform')?.dataRelations)
      .toContain('platform_outbox_quarantine');
    expect(manifest.modules.find(module => module.id === 'platform-cache')?.dataRelations)
      .toEqual(['platform_cache']);
    expect(manifest.modules.find(module => module.id === 'platform-ops')?.migrations).toEqual([]);
    expect(manifest.availableExtensions[0]?.work.jobTypes).toEqual(['ext.manifest-probe.run']);
    expect(manifest.availableExtensions[0]).not.toHaveProperty('enabled');
    expect(JSON.stringify(manifest)).not.toContain('CREATE TABLE');
    expect(setup).not.toHaveBeenCalled();
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('keeps the same Commerce graph and checksum across valid store/provider configuration', () => {
    const expected = buildReleaseManifest(commerce);
    const config = commerce.config.schema.parse({ version: 1,
      store: { id: 'different-store', name: 'Different', currency: 'USD', locale: 'en', timezone: 'UTC' },
      database: { url: 'postgres://unused.invalid/different' },
    });
    const providers = new ProviderRegistry(noopLogger);
    const modules = commerce.createModules({ config, providers });
    const actual = projectReleaseManifest(commerce, [...modules].reverse());
    expect(catalogDigest(actual)).toBe(catalogDigest(expected));
    expect(expected.modules).toHaveLength(24);
  });

  it('projects platform, Commerce, and extension-declared permissions without running extension setup', () => {
    const setup = vi.fn(() => { throw new Error('setup must not run'); });
    const extension = defineExtension({ manifest: {
      id: 'manifest-probe', name: 'Probe', version: '1.0.0', platformVersion: '^1.0.0',
      configuration: z.object({}), permissions: [], declaredPermissions: [{ key: 'probe:read', description: 'Read probe data' }],
      subscribedEvents: [], registeredCommands: [], registeredQueries: [], registeredProviders: [],
    }, setup });
    const permissionKeys = buildReleasePermissionCatalog({
      ...commerce,
      availableExtensions: { ...commerce.availableExtensions, 'manifest-probe': extension },
    });

    expect(permissionKeys).toContain('catalog:read');
    expect(permissionKeys).toContain('media:read');
    expect(permissionKeys).toContain('erp:read');
    expect(permissionKeys).toContain('probe:read');
    expect(permissionKeys).not.toContain('catalog:reed');
    expect(permissionKeys).toEqual([...permissionKeys].sort((left, right) => left.localeCompare(right)));
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects config-dependent job metadata before constructing a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-manifest-'));
    directories.push(directory);
    const configPath = join(directory, 'base.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'runtime', name: 'Runtime' },
      database: { url: 'postgres://unused.invalid/test' }, logging: { level: 'error' } }));
    await expect(bootstrapRelease({ ...base, createModules: ({ config }) => [{
      name: 'probe', version: '1.0.0', baseVersionRange: '^1.0.0',
      jobs: [{ type: `probe.${config.store.id}`, handler: async () => {} }],
    }] }, { configPath, loggerName: 'manifest-test' })).rejects.toThrow('metadata varies');
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('rejects config-dependent signing-purpose authority before constructing a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-manifest-'));
    directories.push(directory);
    const configPath = join(directory, 'base.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'runtime', name: 'Runtime' },
      database: { url: 'postgres://unused.invalid/test' }, logging: { level: 'error' } }));
    await expect(bootstrapRelease({ ...base, createModules: ({ config }) => [{
      name: 'security-probe', version: '1.0.0', baseVersionRange: '^1.0.0',
      runtimeSecurity: { signingKeyPurposes: [config.store.id] }, bindRuntimeSecurity: () => {},
    }] }, { configPath, loggerName: 'manifest-test' })).rejects.toThrow('metadata varies');
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('rejects ambiguous job ownership and preserves significant array order in hashes', () => {
    expect(() => projectReleaseManifest(base, [{
      name: 'probe', version: '1.0.0', baseVersionRange: '^1.0.0',
      jobs: [{ type: 'platform.event.deliver', handler: async () => {} }],
    }])).toThrow('declared by both');
    const manifest = buildReleaseManifest(base);
    const platform = manifest.modules.find(module => module.id === 'platform');
    if (!platform) throw new Error('Missing platform module');
    expect(() => validateWorkOwnership([...manifest.modules, { ...platform, id: 'other', work: { ...platform.work, emittedEventNames: [] } }])).toThrow('jobTypes ownership');
    expect(catalogDigest({ a: 1, b: { c: 2 } })).toBe(catalogDigest({ b: { c: 2 }, a: 1 }));
    expect(catalogDigest(['one', 'two'])).not.toBe(catalogDigest(['two', 'one']));
  });

  it('rejects an artifact checksum mismatch before constructing a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-manifest-'));
    directories.push(directory);
    const configPath = join(directory, 'base.json');
    writeFileSync(configPath, JSON.stringify(base.manifestConfig));
    vi.stubEnv('STOREWEAVE_BUILD_MANIFEST_SHA', 'sha256:changed');
    await expect(bootstrapRelease(base, { configPath, loggerName: 'manifest-test' }))
      .rejects.toThrow('does not match the built artifact');
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('binds the bootstrap-resolved Keyring into an Availability Quote before database construction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-booking-quote-runtime-'));
    directories.push(directory);
    const configPath = join(directory, 'booking.json');
    const secret = Buffer.alloc(32, 23).toString('base64url');
    writeFileSync(configPath, JSON.stringify({
      version: 1, store: { id: 'booking-runtime', name: 'Booking Runtime' },
      database: { url: 'postgres://unused.invalid/booking' }, logging: { level: 'error' }, theme: { id: 'none' },
      security: { signingKeys: [{ id: 'booking-test', secretRef: 'SW_BOOKING_QUOTE_TEST_KEY' }] },
    }));
    vi.stubEnv('SW_BOOKING_QUOTE_TEST_KEY', secret);
    const property = {
      id: '3e0bcf3b-0f44-4696-a5b7-e9fbeb91d230', timezone: 'Pacific/Kiritimati', currency: 'USD', checkInTime: '15:00',
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
    };
    const roomTypeId = '81a8ae9d-5096-48b8-8b59-af3c7a14ce02';
    const properties = {
      getProperty: async () => property,
      getActiveRoomType: async () => ({ id: roomTypeId, maxOccupancyPerUnit: 2, minimumStayNights: 1, maximumStayNights: null }),
      listActiveRoomTypes: async () => [],
      requireLockedQuoteFacts: async () => { throw new Error('not reached'); },
    };
    const propertyModule = {
      name: 'booking-property', version: '0.1.0', baseVersionRange: '^1.0.0',
      dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
      capabilities: { provides: [BOOKING_PROPERTY_READ_CAPABILITY] },
    };
    const availability = composeBookingAvailabilityRuntime(
      bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, properties),
      { maxRoomsPerRequest: 4 },
    );
    const snapshot = [
      { baseNightlyPriceMinor: 12_345, localDate: '2026-09-30', sellableUnits: 4, reservedUnits: 1, nightlyPriceOverrideMinor: null },
      { baseNightlyPriceMinor: 12_345, localDate: '2026-10-01', sellableUnits: 4, reservedUnits: 1, nightlyPriceOverrideMinor: 20_000 },
    ];
    const quoteSnapshot = vi.spyOn(BookingAvailabilityRepository.prototype, 'loadQuoteSnapshot').mockResolvedValue(snapshot);
    let probeKeyring: ReturnType<typeof createKeyring> | undefined;
    const release = {
      ...base,
      id: 'booking-runtime-probe',
      createModules: (context: Parameters<typeof base.createModules>[0]) => [
        ...base.createModules(context), propertyModule, availability.module,
        {
          name: 'booking-runtime-probe', version: '1.0.0', baseVersionRange: '^1.0.0',
          dependencies: { required: [{ name: 'booking-availability', versionRange: '^0.1.0' }] },
          runtimeSecurity: { signingKeyPurposes: ['booking-quote'] },
          bindRuntimeSecurity: (security: RuntimeSecurity) => { probeKeyring = security.keyring; },
        },
      ],
    };
    expect(JSON.stringify(buildReleaseManifest(release))).not.toContain(secret);
    await expect(bootstrapRelease(release, { configPath, loggerName: 'booking-runtime-probe' }))
      .rejects.toThrow('Database constructed');
    expect(databaseConstructed).toHaveBeenCalledTimes(1);
    expect(() => probeKeyring?.derive('another-purpose', 'booking-test'))
      .toThrow('not allowed to derive signing purpose');

    const query = availability.module.queries?.find(entry => entry.descriptor.name === 'booking.availability.getQuote');
    if (!query) throw new Error('Availability Quote query is missing');
    const input = {
      roomTypeId, checkInLocalDate: '2026-09-30', checkOutLocalDate: '2026-10-02', adults: 2, children: 0, roomCount: 1,
    };
    const result = await query.handler(input, { db: {} as never, now: new Date('2026-09-20T12:00:00.000Z') } as never);
    expect(result).toMatchObject({ kind: 'available', quote: { fingerprint: /^booking-quote-v1:booking-test:[0-9a-f]{64}$/ } });
    if (result.kind !== 'available') throw new Error('Expected available Quote');
    const keyring = createKeyring({ activeKeyId: 'booking-test', keys: [{ id: 'booking-test', secret }] });
    const expected = bookingQuoteFingerprintForKey(bookingQuoteFingerprintTerms(
      input, property.id, property.currency,
      [
        { localDate: '2026-09-30', nightlyPriceMinor: 12_345, availableUnits: 3 },
        { localDate: '2026-10-01', nightlyPriceMinor: 20_000, availableUnits: 3 },
      ],
      32_345,
      { freeCancellationHoursBeforeCheckIn: 48, propertyTimeZone: property.timezone, checkInTime: property.checkInTime },
    ), keyring, 'booking-test');
    expect(result.quote.fingerprint).toBe(`booking-quote-v1:booking-test:${expected}`);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(quoteSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', ''],
    ['malformed', 'too-short'],
  ])('rejects a %s Booking Quote signing key before database construction', async (_case, secret) => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-booking-quote-runtime-'));
    directories.push(directory);
    const configPath = join(directory, 'booking.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1, store: { id: 'booking-runtime', name: 'Booking Runtime' },
      database: { url: 'postgres://unused.invalid/booking' }, logging: { level: 'error' }, theme: { id: 'none' },
      security: { signingKeys: [{ id: 'booking-test', secretRef: 'SW_BOOKING_QUOTE_TEST_KEY' }] },
    }));
    vi.stubEnv('SW_BOOKING_QUOTE_TEST_KEY', secret);
    const properties = {
      getProperty: async () => null,
      getActiveRoomType: async () => null,
      listActiveRoomTypes: async () => [],
      requireLockedQuoteFacts: async () => { throw new Error('not reached'); },
    };
    const propertyModule = {
      name: 'booking-property', version: '0.1.0', baseVersionRange: '^1.0.0',
      dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
      capabilities: { provides: [BOOKING_PROPERTY_READ_CAPABILITY] },
    };
    const availability = composeBookingAvailabilityRuntime(
      bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, properties),
      { maxRoomsPerRequest: 4 },
    );
    const release = {
      ...base,
      id: 'booking-runtime-probe',
      createModules: (context: Parameters<typeof base.createModules>[0]) => [
        ...base.createModules(context), propertyModule, availability.module,
      ],
    };
    let error: unknown;
    try {
      await bootstrapRelease(release, { configPath, loggerName: 'booking-runtime-probe' });
    } catch (caught) { error = caught; }
    expect(String(error)).toMatch(/SW_BOOKING_QUOTE_TEST_KEY|32 bytes|base64url/);
    if (secret) expect(String(error)).not.toContain(secret);
    expect(databaseConstructed).not.toHaveBeenCalled();
  });
});
