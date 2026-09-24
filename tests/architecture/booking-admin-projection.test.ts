import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { assembleAdminProjection, type AdminProjectionAssemblyInput, type AdminRouteDefinition } from '../../packages/platform/release/src/admin';
import { buildReleasePermissionCatalog } from '../../packages/platform/release/src/runtime';
import {
  adminProjection, adminProjectionAssembly, adminProjectionFactory, adminProjectionReleaseDefinition,
  resolveBookingAdminProjection,
} from '../../packages/releases/booking/src/admin';
import { release } from '../../packages/releases/booking/src/runtime';
import { validateAdminProjectionModule } from '../../scripts/validate-admin-projection';
import { validateProjectionGraph } from '../../scripts/build-projections.mjs';

const root = resolve(__dirname, '../..');
const permissions = buildReleasePermissionCatalog(release);
type Route = AdminRouteDefinition<string, string, string, string, undefined, unknown>;
const assembled = adminProjectionAssembly as AdminProjectionAssemblyInput<Route>;
const selected = { adminProjectionReleaseDefinition, adminProjectionFactory, adminProjectionAssembly, adminProjection };

function withAssembly(input: AdminProjectionAssemblyInput<Route>) {
  return { ...selected, adminProjectionAssembly: input,
    adminProjectionFactory: { ...adminProjectionFactory, resolve: () => assembleAdminProjection(input) },
    adminProjection: assembleAdminProjection(input) };
}

const validate = (moduleValue: unknown) => validateAdminProjectionModule(moduleValue, 'booking', permissions);

describe('Booking Admin projection', () => {
  it('assembles all Booking routes, permission declarations, UI entries, and MFA Account route', () => {
    expect(resolveBookingAdminProjection()).toEqual(adminProjection);
    expect(adminProjection.routes.map(route => route.path)).toEqual([
      'property', 'room-types', 'availability', 'reservations', 'account',
    ]);
    expect(adminProjection.navSections).toEqual(['booking', 'platform']);
    expect(adminProjection.defaultRoute).toBe('property');
    expect(adminProjection.routes.find(route => route.path === 'account')).toMatchObject({ permissions: [], section: 'platform' });
    for (const route of adminProjection.routes) {
      expect(route.permissions.every(permission => permissions.includes(permission))).toBe(true);
      expect(typeof route.render).toBe('function');
    }
    expect(() => validate(selected)).not.toThrow();
  });

  it('reports missing, duplicate, and stale contribution keys', () => {
    expect(() => resolveBookingAdminProjection(adminProjectionReleaseDefinition, [])).toThrow('missing contribution key "booking.admin.v1"');
    expect(() => resolveBookingAdminProjection(adminProjectionReleaseDefinition, [adminProjectionFactory, adminProjectionFactory]))
      .toThrow('duplicate contribution key "booking.admin.v1"');
    const contributions = assembled.contributions;
    const key = contributions[0]!.key;
    expect(() => validate(withAssembly({ ...assembled, contributions: contributions.slice(1) })))
      .toThrow(`missing contribution key "${key}"`);
    expect(() => assembleAdminProjection({ ...assembled, contributions: [...contributions, contributions[0]!] }))
      .toThrow(`duplicate contribution key "${key}"`);
    expect(() => assembleAdminProjection({ ...assembled, contributions: [...contributions.slice(1), { ...contributions[0]!, key: 'booking-stale' }] }))
      .toThrow('unexpected contribution key "booking-stale"');
  });

  it('rejects invalid permission declarations, route conflicts, and missing UI entries', () => {
    const [first, ...rest] = assembled.contributions;
    const [route, ...routes] = first!.routes;
    const replace = (replacement: Route) => ({ ...assembled,
      contributions: [{ ...first!, routes: [replacement, ...routes] }, ...rest] });
    expect(() => assembleAdminProjection(replace({ ...route!, permissions: ['booking-property:read', 'INVALID'] })))
      .toThrow('contains invalid key "INVALID"');
    expect(() => validate(withAssembly(replace({ ...route!, permissions: ['booking-property:unknown'] }))))
      .toThrow('unknown permission "booking-property:unknown"');
    expect(() => assembleAdminProjection(replace({ ...route!, path: 'account' })))
      .toThrow('duplicate route path "account"');
    expect(() => assembleAdminProjection(replace({ ...route!, render: undefined as never })))
      .toThrow('.render must be a UI entry function');
  });

  it('checks the emitted browser graph for all three modules and excludes server and Commerce inputs', async () => {
    const previousRelease = process.env.STOREWEAVE_RELEASE;
    process.env.STOREWEAVE_RELEASE = 'booking';
    let result;
    try {
      result = await build({ configFile: resolve(root, 'apps/admin/vite.config.ts'),
        logLevel: 'silent', build: { write: false } });
    } finally {
      if (previousRelease === undefined) delete process.env.STOREWEAVE_RELEASE;
      else process.env.STOREWEAVE_RELEASE = previousRelease;
    }
    const outputs = Array.isArray(result) ? result : [result];
    const inputs = outputs.flatMap(output => 'output' in output
      ? output.output.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []) : []);
    for (const module of ['property', 'availability', 'reservation']) {
      expect(inputs.some(input => input.endsWith(`/packages/booking/${module}/src/admin.ts`))).toBe(true);
    }
    expect(inputs.some(input => input.endsWith('/packages/releases/booking/src/admin.tsx'))).toBe(true);
    expect(() => validateProjectionGraph({ root, releaseId: 'booking', target: 'admin',
      source: 'packages/releases/booking/src/admin.tsx', artifact: 'admin/index.html', inputs,
      forbiddenSources: ['packages/commerce', 'packages/releases/commerce', 'packages/extensions'],
    })).not.toThrow();
    for (const foreign of ['packages/releases/booking/src/server.ts', 'packages/commerce/order/src/http.ts']) {
      expect(() => validateProjectionGraph({ root, releaseId: 'booking', target: 'admin',
        source: 'packages/releases/booking/src/admin.tsx', artifact: 'admin/index.html',
        inputs: [...inputs, foreign], forbiddenSources: ['packages/commerce'],
      })).toThrow(`forbidden source "${foreign}"`);
    }
    expect(inputs.some(input => /packages\/(commerce|releases\/commerce|extensions)\/|apps\/api\/|(?:^|\/)src\/(?:server|module|repository|persistence)\.|(?:^|\/)node_modules\/(?:@nestjs|pg|drizzle-orm)\//.test(input))).toBe(false);
  }, 20_000);
});
