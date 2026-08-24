import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Default Theme 發布資產', () => {
  const expectedAssets = {
    'NotoSansTC-Variable.woff2': '37558262fe31587616f0ef047226e6fe86e1d09dfd550acb811f51f92d8974c6',
    'NotoSerifTC-Variable.woff2': 'b56adfc86643cdd2fb9dc54563f5d655837e7e12deaa47e8c2e2e94ef5fdc836',
    'NotoSansTC-OFL.txt': '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
    'NotoSerifTC-OFL.txt': '5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6',
  };

  it('建置的複製步驟會保留已驗證的兩個 WOFF2 與各自的官方授權檔', () => {
    const root = mkdtempSync(join(tmpdir(), 'storeweave-theme-assets-'));
    temporaryRoots.push(root);

    execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/theme-assets.mjs'),
      'copy', '--source', process.cwd(), '--output', join(root, 'dist'),
    ], { encoding: 'utf8' });

    const outputFonts = join(root, 'dist/theme-assets/default/fonts');
    const sourceFonts = join(process.cwd(), 'packages/themes/default/assets/fonts');
    for (const [file, hash] of Object.entries(expectedAssets)) {
      expect(sha256(join(sourceFonts, file))).toBe(hash);
      expect(sha256(join(outputFonts, file))).toBe(hash);
    }

    writeFileSync(join(outputFonts, 'NotoSansTC-Variable.woff2'), 'tampered');
    const verify = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts/theme-assets.mjs'),
      'verify', '--assets', join(root, 'dist/theme-assets/default'),
    ], { encoding: 'utf8' });
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('sha256 mismatch');
  });

  it('以 list CLI 提供 release 所需的單一資產清單', () => {
    const list = execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/theme-assets.mjs'), 'list',
    ], { encoding: 'utf8' });

    expect(list.trim().split('\n')).toEqual([
      'fonts/NotoSansTC-Variable.woff2',
      'fonts/NotoSerifTC-Variable.woff2',
      'fonts/NotoSansTC-OFL.txt',
      'fonts/NotoSerifTC-OFL.txt',
    ]);
  });
});
