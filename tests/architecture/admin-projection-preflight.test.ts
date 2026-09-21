import {
  assembleAdminProjection,
  type AdminProjectionAssemblyInput,
  type AdminRouteDefinition,
} from '../../packages/platform/release/src/admin';
import { validateAdminProjectionModule } from '../../scripts/validate-admin-projection';
import { describe, expect, it } from 'vitest';

type TestRoute = AdminRouteDefinition<'products', string, string, 'commerce', never, null>;
const route: TestRoute = {
  path: 'products',
  navLabel: 'products',
  icon: 'box',
  section: 'commerce',
  title: 'Products',
  subtitle: 'Browse products',
  permissions: ['catalog:read'],
  render: () => null,
};
const assembly = {
  requiredContributionKeys: ['commerce.admin.routes.v1'],
  contributions: [{ key: 'commerce.admin.routes.v1', routes: [route] }],
  defaultRoute: 'products',
} as const satisfies AdminProjectionAssemblyInput<TestRoute>;
const definition = {
  manifest: {
    id: 'commerce',
    version: '1.0.0',
    selected: { modules: [], themes: [], extensions: [] },
    targets: {
      server: { key: 'commerce.server.v1' },
      worker: { key: 'commerce.worker.v1' },
      admin: { key: 'commerce.admin.v1' },
      cli: { key: 'commerce.cli.v1' },
      config: { key: 'commerce.config.v1' },
      storefront: { key: 'commerce.storefront.v1' },
    },
    metadata: null,
  },
} as const;
function moduleFor(input: AdminProjectionAssemblyInput<TestRoute> = assembly) {
  return {
    adminProjectionReleaseDefinition: definition,
    adminProjectionFactory: {
      target: 'admin',
      key: 'commerce.admin.v1',
      resolve: () => assembleAdminProjection(input),
    },
    adminProjectionAssembly: input,
    adminProjection: assembleAdminProjection(input),
  };
}

const selectedCommerceModule = moduleFor();

describe('Admin projection build preflight', () => {
  it('accepts the assembled projection for its selected Commerce release and Admin key', () => {
    expect(() => validateAdminProjectionModule(selectedCommerceModule, 'commerce', ['catalog:read'])).not.toThrow();
  });

  it('rejects a projection selected under a different release id', () => {
    expect(() => validateAdminProjectionModule(selectedCommerceModule, 'base', ['catalog:read'])).toThrow(
      'belongs to release "commerce", expected "base"',
    );
  });

  it('rejects a factory key that differs from the release Admin target declaration', () => {
    const mismatched = {
      ...selectedCommerceModule,
      adminProjectionFactory: { ...selectedCommerceModule.adminProjectionFactory, key: 'base.admin.v1' },
    };
    expect(() => validateAdminProjectionModule(mismatched, 'commerce', ['catalog:read'])).toThrow(
      'does not match release target key "commerce.admin.v1"',
    );
  });

  it('rejects incomplete contribution rows and a default route outside the assembled routes', () => {
    const firstContribution = assembly.contributions[0]!;
    const firstRoute = firstContribution.routes[0]!;
    const incompleteAssembly = {
      ...assembly,
      contributions: [{
        ...firstContribution,
        routes: [{ ...firstRoute, render: undefined }, ...firstContribution.routes.slice(1)],
      }],
    } as unknown as AdminProjectionAssemblyInput<TestRoute>;
    expect(() => validateAdminProjectionModule(moduleFor(incompleteAssembly), 'commerce', ['catalog:read']))
      .toThrow(/\.render must be a UI entry function/);

    const missingDefault = {
      ...selectedCommerceModule,
      adminProjectionAssembly: { ...assembly, defaultRoute: 'missing-route' } as unknown as AdminProjectionAssemblyInput<TestRoute>,
    };
    expect(() => validateAdminProjectionModule(missingDefault, 'commerce', ['catalog:read'])).toThrow(
      'default route "missing-route" is not contributed',
    );
  });

  it('accepts declared permission keys and rejects a well-formed but unknown key', () => {
    expect(() => validateAdminProjectionModule(selectedCommerceModule, 'commerce', ['catalog:read'])).not.toThrow();
    const misspelledRoute = { ...route, permissions: ['catalog:reed'] };
    const misspelledAssembly = {
      ...assembly,
      contributions: [{ key: 'commerce.admin.routes.v1', routes: [misspelledRoute] }],
    } as unknown as AdminProjectionAssemblyInput<TestRoute>;
    expect(() => validateAdminProjectionModule(moduleFor(misspelledAssembly), 'commerce', ['catalog:read']))
      .toThrow('Admin route "products" references unknown permission "catalog:reed" in release "commerce"');
  });
});
