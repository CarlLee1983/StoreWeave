import { describe, expect, it } from 'vitest';
import { AdminProjectionAssemblyError, assembleAdminProjection } from '../src/admin';

function route(overrides: Record<string, unknown> = {}) {
  return {
    path: 'products',
    navLabel: 'products',
    icon: 'box',
    section: 'commerce',
    title: 'productsTitle',
    subtitle: 'productsSubtitle',
    permissions: ['catalog:read'],
    render: () => null,
    ...overrides,
  };
}

function assemble(
  contributions: readonly unknown[] = [{ key: 'commerce.routes.v1', routes: [route()] }],
  defaultRoute = 'products',
  requiredContributionKeys: readonly string[] = ['commerce.routes.v1'],
) {
  return assembleAdminProjection({
    requiredContributionKeys,
    contributions,
    defaultRoute,
  } as never);
}

describe('Admin projection assembly', () => {
  it('throws a named assembly error for an invalid contribution', () => {
    expect(() => assemble([{ key: 'commerce.routes.v1', routes: [route({ render: undefined })] }]))
      .toThrow(AdminProjectionAssemblyError);
  });

  it('flattens the exact route contributions and derives navigation section order', () => {
    const result = assemble([
      { key: 'commerce.catalog.v1', routes: [route(), route({ path: 'orders', section: 'commerce', permissions: ['order:read'] })] },
      { key: 'platform.identity.v1', routes: [route({ path: 'operators', section: 'platform', permissions: ['users:read'] })] },
    ], 'products', ['commerce.catalog.v1', 'platform.identity.v1']);

    expect(result.contributionKeys).toEqual(['commerce.catalog.v1', 'platform.identity.v1']);
    expect(result.routes.map(entry => entry.path)).toEqual(['products', 'orders', 'operators']);
    expect(result.navSections).toEqual(['commerce', 'platform']);
    expect(result.defaultRoute).toBe('products');
  });

  it.each([
    ['missing contribution key', [], /missing contribution key "commerce\.routes\.v1"/],
    ['unexpected contribution key', [{ key: 'other.routes.v1', routes: [route()] }], /unexpected contribution key "other\.routes\.v1"/],
    ['duplicate contribution key', [{ key: 'commerce.routes.v1', routes: [route()] }, { key: 'commerce.routes.v1', routes: [route({ path: 'orders' })] }], /duplicate contribution key "commerce\.routes\.v1"/],
    ['empty route contribution', [{ key: 'commerce.routes.v1', routes: [] }], /must declare at least one route/],
  ])('rejects %s with a contribution diagnostic', (_label, contributions, message) => {
    expect(() => assemble(contributions as readonly unknown[])).toThrow(message);
  });

  it('rejects duplicate or malformed routes and a default route that is not contributed', () => {
    expect(() => assemble([{ key: 'commerce.routes.v1', routes: [route(), route()] }])).toThrow(/duplicate route path "products"/);
    expect(() => assemble([{ key: 'commerce.routes.v1', routes: [route({ path: 'Products' })] }])).toThrow(/must be a lowercase route key/);
    expect(() => assemble(undefined, 'orders')).toThrow(/default route "orders" is not contributed/);
  });

  it.each([
    ['missing navigation label', route({ navLabel: '' }), /navLabel must be a non-empty string/],
    ['missing UI entry', route({ render: undefined }), /render must be a UI entry function/],
    ['missing permissions', route({ permissions: undefined }), /permissions must be an array/],
    ['malformed permission', route({ permissions: ['catalog:*'] }), /invalid key "catalog:\*"/],
    ['wildcard permission', route({ permissions: ['*'] }), /invalid key "\*"/],
    ['duplicate permission', route({ permissions: ['catalog:read', 'catalog:read'] }), /contains duplicate key "catalog:read"/],
    ['empty module', route({ module: '  ' }), /module must be a non-empty string/],
    ['incomplete action', route({ action: { label: 'createProduct' } }), /action.targetId is required/],
    ['non-function badge', route({ badge: 'LIVE' }), /badge must be a UI badge function/],
  ])('rejects %s before returning a projection', (_label, invalidRoute, message) => {
    expect(() => assemble([{ key: 'commerce.routes.v1', routes: [invalidRoute] }])).toThrow(message);
  });
});
