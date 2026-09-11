import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, importsOf, sourceFiles } from './source-graph';

/**
 * B16 範例模組只能經過 base 的公開入口接入（ADR 0050）。守的是兩條線：
 * 執行期檔案（資料、Command、Query、Job、頁面）不碰 Theme／瀏覽器那一層與應用層；
 * Theme 檔案只做渲染，不碰資料層或執行期能力。
 */
const PACKAGE = 'packages/examples/file-requests';
const packageRoot = join(ROOT, PACKAGE);
const files = sourceFiles(`${PACKAGE}/src`);
const THEME_FILE = join(packageRoot, 'src/theme.ts');
const INDEX_FILE = join(packageRoot, 'src/index.ts');

const RUNTIME_ENTRIES = new Set([
  '@storeweave/kernel', '@storeweave/contracts', '@storeweave/authorization', '@storeweave/db', '@storeweave/jobs', '@storeweave/cache',
  '@storeweave/storage', '@storeweave/notifications', 'zod', 'drizzle-orm', 'drizzle-orm/pg-core',
]);
const THEME_ENTRIES = new Set(['@storeweave/kernel', '@storeweave/i18n']);

function external(file: string): string[] {
  return importsOf(file).filter(spec => !spec.startsWith('.') && !spec.startsWith('node:'));
}

function relativeTargets(file: string): string[] {
  return importsOf(file).filter(spec => spec.startsWith('.')).map(spec => resolve(dirname(file), spec));
}

describe('B16 範例模組的邊界', () => {
  it('掃描到範例模組的原始碼', () => {
    expect(files.map(file => relative(packageRoot, file))).toEqual(expect.arrayContaining(['src/module.ts', 'src/theme.ts', 'src/jobs.ts']));
  });

  it.each(files.filter(file => file !== THEME_FILE && file !== INDEX_FILE).map(file => relative(ROOT, file)))(
    '%s 只經過 base 公開入口，也不引用 Theme 層', (path) => {
      const file = join(ROOT, path);
      expect(external(file).filter(spec => !RUNTIME_ENTRIES.has(spec))).toEqual([]);
      expect(relativeTargets(file).filter(target => target.startsWith(join(packageRoot, 'src/theme')))).toEqual([]);
    },
  );

  it('Theme 檔案只做渲染：不碰資料層、Storage、Job 或其他執行期能力', () => {
    expect(external(THEME_FILE).filter(spec => !THEME_ENTRIES.has(spec))).toEqual([]);
    expect(relativeTargets(THEME_FILE).map(target => relative(packageRoot, target)).sort()).toEqual(['src/pages', 'src/types']);
  });

  it('相對 import 都留在套件內，不跨進其他模組或 apps', () => {
    const escaping = files.flatMap(file => relativeTargets(file)
      .filter(target => relative(packageRoot, target).startsWith('..'))
      .map(target => `${relative(ROOT, file)} -> ${relative(ROOT, target)}`));
    expect(escaping).toEqual([]);
  });
});
