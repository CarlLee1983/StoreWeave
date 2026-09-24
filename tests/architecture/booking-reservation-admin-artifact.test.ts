import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { assembleAdminProjection } from '../../packages/platform/release/src/admin';
import { bookingReservationAdminContribution } from '../../packages/booking/reservation/src/admin';

it('assembles the Reservation contribution with its navigation and read permission', () => {
  const projection = assembleAdminProjection({
    requiredContributionKeys: ['booking-reservation'],
    contributions: [bookingReservationAdminContribution], defaultRoute: 'reservations',
  });
  expect(projection.routes.map(route => route.path)).toEqual(['reservations']);
  expect(projection.routes[0].permissions).toEqual(['booking-reservation:operator-read']);
  expect(projection.navSections).toEqual(['booking']);
});

it('bundles Reservation Admin without server, persistence, provider, or Commerce code', async () => {
  const result = await build({
    entryPoints: [resolve('packages/booking/reservation/src/admin.ts')],
    bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true, external: ['react'],
  });
  const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll('\\', '/'));
  expect(inputs).toEqual(expect.arrayContaining([
    'packages/booking/reservation/src/admin.ts', 'packages/booking/reservation/src/admin-api.ts',
  ]));
  expect(inputs.filter(path => /(?:^|\/)(?:apps\/(?:api|worker)|packages\/commerce|packages\/releases\/(?:booking|commerce)|node_modules\/@nestjs|node_modules\/(?:pg|drizzle-orm)|[^/]*(?:migrations?|repository|database|db|provider)\.ts)(?:\/|$)/.test(path)))
    .toEqual([]);
});
