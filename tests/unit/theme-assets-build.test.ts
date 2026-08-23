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
  it('建置的複製步驟會保留已驗證的兩個 WOFF2 與授權檔', () => {
    const root = mkdtempSync(join(tmpdir(), 'storeweave-theme-assets-'));
    temporaryRoots.push(root);

    execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/theme-assets.mjs'),
      'copy', '--source', process.cwd(), '--output', join(root, 'dist'),
    ], { encoding: 'utf8' });

    const outputFonts = join(root, 'dist/theme-assets/default/fonts');
    const sourceFonts = join(process.cwd(), 'packages/themes/default/assets/fonts');
    for (const file of ['NotoSansTC-Variable.woff2', 'NotoSerifTC-Variable.woff2', 'OFL.txt']) {
      expect(sha256(join(outputFonts, file))).toBe(sha256(join(sourceFonts, file)));
    }

    writeFileSync(join(outputFonts, 'NotoSansTC-Variable.woff2'), 'tampered');
    const verify = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts/theme-assets.mjs'),
      'verify', '--assets', join(root, 'dist/theme-assets/default'),
    ], { encoding: 'utf8' });
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('sha256 mismatch');
  });
});
