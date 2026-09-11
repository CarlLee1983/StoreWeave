/** One build selection supplies all four process adapters. */
export const releases = {
  base: {
    runtime: 'packages/platform/bundle/src/releases/base.ts',
    http: 'apps/api/src/releases/base.ts',
    seed: 'scripts/seeds/base.ts',
    admin: false,
    themeAssets: undefined,
  },
  // B16 的模組範例：base 加上一個自己有資料表、前後台頁面與背景工作的非商務模組。
  'file-requests': {
    runtime: 'packages/platform/bundle/src/releases/file-requests.ts',
    http: 'apps/api/src/releases/file-requests.ts',
    seed: 'scripts/seeds/file-requests.ts',
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
