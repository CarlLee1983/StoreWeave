import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveThemeAssetsDir } from '@storeweave/api';

const assetTheme = { id: 'default', staticAssets: { prefix: '/theme/default/' } };

describe('Theme 靜態資產目錄', () => {
  it('只接受 release artifact 或明確指定的開發目錄，遺失時立即失敗', () => {
    const root = mkdtempSync(join(tmpdir(), 'storeweave-theme-path-'));
    try {
      expect(() => resolveThemeAssetsDir(assetTheme, root)).toThrow('declares static assets');

      const releaseAssets = join(root, 'theme-assets', 'default');
      mkdirSync(releaseAssets, { recursive: true });
      expect(resolveThemeAssetsDir(assetTheme, root)).toBe(releaseAssets);

      const sourceAssets = join(root, 'source-assets');
      mkdirSync(sourceAssets);
      expect(resolveThemeAssetsDir(assetTheme, root, sourceAssets)).toBe(sourceAssets);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不替未宣告資產的 Theme 猜測或掛載目錄', () => {
    expect(resolveThemeAssetsDir({ id: 'plain' }, process.cwd())).toBeUndefined();
  });
});
