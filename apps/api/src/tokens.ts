import type { Runtime, StorefrontTheme } from '@storeweave/kernel';

export const RUNTIME = Symbol('COMMERCE_RUNTIME');
export const THEME = Symbol('COMMERCE_THEME');
export const RELEASE = Symbol('COMMERCE_RELEASE');

export interface ReleaseInfo {
  version: string;
  configPath: string;
  adminDir?: string;
  /** Theme-owned public assets packaged with this release, never merchant product media. */
  themeAssetsDir?: string;
}

export type { Runtime, StorefrontTheme };
