import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ThemeAssetDirectoryOptions {
  configuredDir?: string;
  workingDirectory?: string;
  moduleDirectory?: string;
  fileExists?: (path: string) => boolean;
}

/**
 * Resolve the release-owned editorial media without assuming that a bundled
 * process and its source checkout share the same directory layout.
 */
export function resolveThemeAssetsDir({
  configuredDir = process.env.COMMERCE_THEME_ASSETS_DIR,
  workingDirectory = process.cwd(),
  moduleDirectory = __dirname,
  fileExists = existsSync,
}: ThemeAssetDirectoryOptions = {}): string | undefined {
  const candidates = [
    configuredDir,
    // Native release: <release>/app/api.js and <release>/theme-assets.
    join(moduleDirectory, '..', 'theme-assets'),
    // A compiled API started from a checkout can still use the checked-in
    // artwork when a build was created before these media files existed.
    join(workingDirectory, 'packages', 'themes', 'default', 'assets'),
    // tsx development: <repo>/apps/api/src/main.ts.
    join(moduleDirectory, '..', '..', '..', 'packages', 'themes', 'default', 'assets'),
  ];

  // The storefront refers to this image by a fixed, theme-owned filename. A
  // directory alone is not sufficient evidence that it is this theme's media
  // bundle: a stale mount must not shadow a valid packaged/source fallback.
  return candidates.find((directory): directory is string =>
    typeof directory === 'string' && fileExists(join(directory, 'woven-day-hero.png')),
  );
}
