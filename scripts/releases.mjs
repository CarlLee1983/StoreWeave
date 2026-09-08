/** One build selection supplies all four process adapters. */
export const releases = {
  base: {
    runtime: 'packages/platform/bundle/src/releases/base.ts',
    http: 'apps/api/src/releases/base.ts',
    seed: 'scripts/seeds/base.ts',
    admin: false,
    themeAssets: undefined,
  },
  commerce: {
    runtime: 'packages/platform/bundle/src/releases/commerce.ts',
    http: 'apps/api/src/releases/commerce.ts',
    seed: 'scripts/seeds/commerce.ts',
    admin: true,
    themeAssets: 'packages/themes/default/assets',
  },
};
