import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '..', '..');

/** 專案內的 TypeScript 原始檔；跳過建置產物與型別宣告。 */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/**
 * 一個檔案 import 了哪些東西。三種寫法都要認得——只比對 `from '...'` 的守衛，
 * 用 `require()` 或動態 `import()` 就繞過去了。
 */
export function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}
