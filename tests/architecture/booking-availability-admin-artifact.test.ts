import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { assembleAdminProjection } from '../../packages/platform/release/src/admin';
import { bookingAvailabilityAdminContribution } from '../../packages/booking/availability/src/admin';

it('assembles the Availability contribution through the Admin route contract', () => {
  const projection = assembleAdminProjection({
    requiredContributionKeys: ['booking-availability'],
    contributions: [bookingAvailabilityAdminContribution],
    defaultRoute: 'availability',
  });
  expect(projection.routes.map(route => route.path)).toEqual(['availability']);
  expect(projection.navSections).toEqual(['booking']);
});

it('bundles the availability Admin contribution without persistence, server, or Commerce code', async () => {
  const result = await build({
    entryPoints: [resolve('packages/booking/availability/src/admin.ts')],
    bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true, external: ['react'],
  });
  const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
  expect(inputs).toEqual(expect.arrayContaining([
    'packages/booking/availability/src/admin.ts', 'packages/booking/availability/src/admin-api.ts',
  ]));
  expect(inputs.filter(path => /(?:^|\/)(?:apps\/(?:api|worker)|packages\/commerce|packages\/releases\/commerce|node_modules\/@nestjs|node_modules\/(?:pg|drizzle-orm)|[^/]*(?:migrations?|repository|database|db)\.ts)(?:\/|$)/.test(path)))
    .toEqual([]);
});
