import type { Runtime, StorefrontTheme } from '@storeweave/kernel';

export const RUNTIME = Symbol('COMMERCE_RUNTIME');
export const THEME = Symbol('COMMERCE_THEME');
export const RELEASE = Symbol('COMMERCE_RELEASE');

export interface ReleaseInfo {
  version: string;
  configPath: string;
  adminDir?: string;
  /** Theme 宣告公開路徑後，由 release 或明確的開發環境提供的資產目錄。 */
  themeAssetsDir?: string;
}

export type { Runtime, StorefrontTheme };
