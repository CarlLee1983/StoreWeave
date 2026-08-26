import { describe, expect, it } from 'vitest';
import { resolveThemeAssetsDir } from '../../apps/api/src/theme-assets';

describe('theme asset directory resolution', () => {
  it('uses an existing configured directory', () => {
    const fileExists = (path: string) => path === '/mounted/theme-media/woven-day-hero.png';

    expect(resolveThemeAssetsDir({ configuredDir: '/mounted/theme-media', fileExists })).toBe('/mounted/theme-media');
  });

  it('falls back when a configured directory is stale or has no theme artwork', () => {
    const sourceAssets = '/workspace/packages/themes/default/assets';

    expect(resolveThemeAssetsDir({
      configuredDir: '/missing/theme-media',
      moduleDirectory: '/workspace/dist/app',
      workingDirectory: '/workspace',
      fileExists: (path) => path === `${sourceAssets}/woven-day-hero.png`,
    })).toBe(sourceAssets);
  });

  it('finds source artwork when a compiled app runs from a checkout without packaged media', () => {
    const sourceAssets = '/workspace/packages/themes/default/assets';

    expect(resolveThemeAssetsDir({
      moduleDirectory: '/workspace/dist/app',
      workingDirectory: '/workspace',
      fileExists: (path) => path === `${sourceAssets}/woven-day-hero.png`,
    })).toBe(sourceAssets);
  });

  it('prefers the media packaged beside the compiled API', () => {
    const packagedAssets = '/release/theme-assets';

    expect(resolveThemeAssetsDir({
      moduleDirectory: '/release/app',
      workingDirectory: '/workspace',
      fileExists: (path) => path === `${packagedAssets}/woven-day-hero.png`,
    })).toBe(packagedAssets);
  });
});
