import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The build selector is intentionally plain JavaScript; its runtime shape is asserted below.
// @ts-expect-error no TypeScript declaration for the build-only selector
import { releases } from '../../scripts/releases.mjs';
import { resolveBuildProjections, validateBuildGraph, validateProjectionGraph } from '../../scripts/build-projections.mjs';

const root = resolve(__dirname, '../..');
const booking = releases.booking;

describe('Booking release target boundaries', () => {
  it('registers its own build inputs and rejects a foreign Commerce implementation', () => {
    expect(resolveBuildProjections({ root, releaseId: 'booking', release: booking }).map(projection => projection.status))
      .toEqual(['built', 'built', 'built', 'built']);
    expect(() => validateBuildGraph({
      root, releaseId: 'booking', target: 'manifest',
      inputs: [booking.runtime, 'packages/commerce/order/src/module.ts'], forbiddenSources: booking.forbiddenInputs,
    })).toThrow('forbidden source "packages/commerce/order/src/module.ts"');
  });

  it('excludes Booking implementation from other product builds', () => {
    const bookingSources = [
      'packages/booking/property/src/index.ts',
      'packages/releases/booking/src/runtime.ts',
      'packages/themes/booking-default/src/index.ts',
      'apps/api/src/releases/booking.ts',
      'scripts/seeds/booking.ts',
    ];
    for (const releaseId of ['base', 'commerce', 'file-requests'] as const) {
      const release = releases[releaseId];
      for (const source of bookingSources) {
        expect(() => validateBuildGraph({
          root, releaseId, target: 'manifest', inputs: [release.runtime, source],
          forbiddenSources: release.forbiddenInputs,
        }), `${releaseId} should reject ${source}`).toThrow(`forbidden source "${source}"`);
      }
      expect(validateBuildGraph({
        root, releaseId, target: 'manifest',
        inputs: [release.runtime, 'packages/platform/release/src/runtime.ts', 'apps/api/src/releases/booking.test.ts'],
        forbiddenSources: release.forbiddenInputs,
      })).toEqual([
        'apps/api/src/releases/booking.test.ts', 'packages/platform/release/src/runtime.ts', release.runtime,
      ].sort());
    }
  });

  it('rejects cross-target and React imports from the Booking server and worker', () => {
    expect(() => validateProjectionGraph({
      root, releaseId: 'booking', target: 'server', source: booking.server, artifact: 'app/api.js',
      inputs: [booking.server, booking.worker],
    })).toThrow('forbidden source "packages/releases/booking/src/worker.ts"');
    expect(() => validateProjectionGraph({
      root, releaseId: 'booking', target: 'worker', source: booking.worker, artifact: 'app/worker.js',
      inputs: [booking.worker, 'node_modules/react/index.js'],
    })).toThrow('forbidden source "node_modules/react/index.js"');
  });

  it('has no product switch or Commerce implementation import in its assembly source', () => {
    for (const path of [booking.runtime, booking.server, booking.worker, booking.cli, booking.configProjection, booking.storefrontProjection, booking.adminProjection]) {
      const source = readFileSync(resolve(root, path), 'utf8');
      expect(source).not.toMatch(/@storeweave\/(?:commerce-|release-commerce)|packages\/commerce\//);
      expect(source).not.toMatch(/release\.id\s*===\s*['"](?:commerce|booking)['"]/);
    }
  });
});
