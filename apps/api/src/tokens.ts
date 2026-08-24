import type { Runtime, StorefrontTheme } from '@storeweave/kernel';

export const RUNTIME = Symbol('COMMERCE_RUNTIME');
export const THEME = Symbol('COMMERCE_THEME');
export const RELEASE = Symbol('COMMERCE_RELEASE');

export interface ReleaseInfo {
  version: string;
  configPath: string;
  adminDir?: string;
}

export type { Runtime, StorefrontTheme };
