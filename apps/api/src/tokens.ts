import type { Runtime, StorefrontTheme } from '@storeweave/kernel';

export const RUNTIME = Symbol('COMMERCE_RUNTIME');
export const THEME = Symbol('COMMERCE_THEME');
export const RELEASE = Symbol('COMMERCE_RELEASE');

export interface ReleaseInfo {
  version: string;
  configPath: string;
  adminDir?: string;
  /** Default Theme 的同源靜態資產；release 與本機開發都由啟動程式提供。 */
  themeAssetsDir?: string;
}

export type { Runtime, StorefrontTheme };
