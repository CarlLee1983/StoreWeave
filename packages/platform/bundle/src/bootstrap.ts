import { PlatformError } from '@storeweave/contracts';
import type { CommerceConfig } from '@storeweave/config';
import type { StorefrontTheme } from '@storeweave/kernel';
import { bootstrapRelease, type BootstrapOptions, type ReleaseBootstrapResult } from './bootstrap-release';
import { release } from './releases/commerce';

/** Legacy Commerce entrypoint. Build-selected entrypoints use bootstrapRelease directly. */
export const AVAILABLE_THEMES = release.availableThemes;
export type BootstrapResult = ReleaseBootstrapResult<CommerceConfig> & { theme: StorefrontTheme };

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const result = await bootstrapRelease(release, options);
  if (!result.theme) {
    await result.runtime.close();
    throw PlatformError.validation('Commerce requires a storefront theme');
  }
  return { ...result, theme: result.theme };
}
