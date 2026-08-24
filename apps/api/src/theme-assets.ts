import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StorefrontTheme } from '@storeweave/kernel';

type AssetBearingTheme = Pick<StorefrontTheme, 'id' | 'staticAssets'>;

/**
 * Release 一律從自己的 artifact 讀取 Theme 資產；本機原始碼路徑必須由開發者明確指定。
 */
export function resolveThemeAssetsDir(
  theme: AssetBearingTheme,
  releaseRoot: string,
  override = process.env.COMMERCE_THEME_ASSETS_DIR,
): string | undefined {
  if (!theme.staticAssets) return undefined;

  const assetsDir = override
    ? resolve(override)
    : join(releaseRoot, 'theme-assets', theme.id);
  if (!existsSync(assetsDir)) {
    throw new Error(
      `Theme "${theme.id}" declares static assets, but they are missing at ${assetsDir}. `
      + 'Set COMMERCE_THEME_ASSETS_DIR for source development or build the release artifact.',
    );
  }
  return assetsDir;
}
