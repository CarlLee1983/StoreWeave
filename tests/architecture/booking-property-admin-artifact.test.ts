import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { assembleAdminProjection } from '../../packages/platform/release/src/admin';
import { bookingPropertyAdminContribution } from '../../packages/booking/property/src/admin';

it('assembles the Property contribution through the Admin route contract', () => {
  const projection = assembleAdminProjection({
    requiredContributionKeys: ['booking-property'],
    contributions: [bookingPropertyAdminContribution],
    defaultRoute: 'property',
  });
  expect(projection.routes.map(route => route.path)).toEqual(['property', 'room-types']);
  expect(projection.navSections).toEqual(['booking']);
});

it('bundles the booking-property Admin contribution without server or Commerce code', async () => {
  const result = await build({
    entryPoints: [resolve('packages/booking/property/src/admin.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    external: ['react'],
  });

  const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
  expect(inputs).toEqual(expect.arrayContaining([
    'packages/booking/property/src/admin.ts',
    'packages/booking/property/src/admin-api.ts',
  ]));
  expect(inputs.filter(path => /(?:^|\/)(?:apps\/(?:api|worker)|packages\/commerce|packages\/releases\/commerce|node_modules\/@nestjs|node_modules\/(?:pg|drizzle-orm)|[^/]*(?:migrations?|repository|database|db)\.ts)(?:\/|$)/.test(path)))
    .toEqual([]);
  expect(result.outputFiles![0]!.text).not.toMatch(/(?:node:|@storeweave\/booking-property|@nestjs\/|drizzle-orm|packages\/commerce)/);
});
