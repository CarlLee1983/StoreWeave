import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, importsOf } from './source-graph';

/**
 * Spec 0008 §4-§6 的三條驗收，補在守衛層而不是功能測試：
 *   1. Admin 的瀏覽器 bundle 只能透過 browser-safe、type-only 的 subpath 拿到序列化契約，
 *      不能沿著 import 圖拉到 Nest、Drizzle、pg 或任何 Node runtime 相依。
 *   2. 下線的 `reloadKey` 平行實作不得回來。
 *   3. 這一輪明確不引入 TanStack Table、React Hook Form（`@tanstack/react-query` 允許）。
 */

/** apps/admin/src 底下的 .ts / .tsx 原始檔；`source-graph.ts` 的 sourceFiles() 不認 .tsx，這裡自己走一輪。 */
function adminSourceFiles(): string[] {
  const out: string[] = [];
  const root = join(ROOT, 'apps/admin/src');
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const ADMIN_FILES = adminSourceFiles();

describe('Admin 瀏覽器 bundle 不得拉入 Node runtime 相依（spec 0008 §4）', () => {
  it('掃描到 apps/admin/src 的原始碼', () => {
    expect(ADMIN_FILES.length).toBeGreaterThan(20);
  });

  /** workspace 套件名稱 -> 套件目錄，用來把 `@storeweave/xxx` 的 import 解析回原始檔。 */
  const packageDirs = new Map<string, string>();
  for (const scope of ['apps', 'packages']) {
    const scanDir = (dir: string) => {
      const full = join(ROOT, dir);
      for (const entry of readdirSync(full)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const entryPath = join(full, entry);
        if (!statSync(entryPath).isDirectory()) continue;
        const manifest = join(entryPath, 'package.json');
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
          if (pkg.name) packageDirs.set(pkg.name, entryPath);
          else scanDir(`${dir}/${entry}`);
        } catch {
          scanDir(`${dir}/${entry}`);
        }
      }
    };
    scanDir(scope);
  }

  function candidates(path: string): string[] {
    return [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')];
  }

  function existingFile(path: string): string | null {
    for (const candidate of candidates(path)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 不存在就換下一個候選
      }
    }
    return null;
  }

  /** 把 `@storeweave/xxx` 或 `@storeweave/xxx/sub` 解析成套件內對應的原始檔（照 exports 的 default/types）。 */
  function resolveWorkspaceSpecifier(spec: string): string | null {
    const match = spec.match(/^(@storeweave\/[a-z0-9-]+)(\/.*)?$/);
    if (!match) return null;
    const [, pkgName, subpath] = match;
    const dir = packageDirs.get(pkgName);
    if (!dir) return null;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = subpath ? `.${subpath}` : '.';
    const exportsField = pkg.exports?.[key];
    let entry: string | undefined;
    if (exportsField) entry = typeof exportsField === 'string' ? exportsField : (exportsField.default ?? exportsField.types);
    else if (key === '.') entry = pkg.types ?? pkg.main;
    if (!entry) return null;
    return existingFile(resolve(dir, entry));
  }

  const FORBIDDEN_RUNTIME = (spec: string): boolean =>
    spec.startsWith('@nestjs/') || spec === 'pg' || spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/') || spec.startsWith('node:');

  /**
   * 只算「值」層級的 import：`import type` / `export type ... from` 這種寫法在 bundler
   * 手上整條 import 會被抹掉，根本不會進 bundle。`packages/commerce/order/src/http.ts`
   * 對 `./dto` 就是這樣的 `import type`——dto 內部即使 import 了 runtime 的
   * `@storeweave/shipping`，只要 http.ts 只拿它的型別，那條邊就不會被打包，
   * 這條守衛也不該把它算進「拉進 bundle」。
   */
  function valueImportsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const specifiers: string[] = [];
    for (const match of source.matchAll(/\b(import|export)\s+(type\s+)?[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
      const [, , typeOnly, spec] = match;
      if (!typeOnly) specifiers.push(spec);
    }
    for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
    return specifiers;
  }

  /** 從 apps/admin/src 出發，沿相對 import 與 workspace 套件 import 做深度優先追蹤。 */
  function transitiveClosure(startFiles: string[]): { visited: Set<string>; forbidden: string[] } {
    const visited = new Set<string>();
    const forbidden: string[] = [];
    const stack = [...startFiles];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of valueImportsOf(file)) {
        if (FORBIDDEN_RUNTIME(spec)) {
          forbidden.push(`${relative(ROOT, file)} -> ${spec}`);
          continue;
        }
        if (spec.startsWith('.')) {
          const next = existingFile(resolve(dirname(file), spec));
          if (next) stack.push(next);
          continue;
        }
        if (spec.startsWith('@storeweave/')) {
          const next = resolveWorkspaceSpecifier(spec);
          if (next) stack.push(next);
        }
        // 其他外部套件（react、zod...）不是這條守衛要管的範圍。
      }
    }
    return { visited, forbidden };
  }

  it('order 的 browser-safe subpath 真的是 type-only：resolve 不到 runtime 檔案', () => {
    const httpFile = resolveWorkspaceSpecifier('@storeweave/order/http');
    expect(httpFile).toBe(join(ROOT, 'packages/commerce/order/src/http.ts'));
  });

  it('apps/admin/src 的 import 圖沒有拉到 Nest、Drizzle、pg 或任何 node: 相依', () => {
    const { visited, forbidden } = transitiveClosure(ADMIN_FILES);
    // 掃不到東西的測試會永遠是綠的：確認真的走進了 workspace 套件（不是只停在 admin 自己）。
    // order/http 本身是全程 `import type` 才拿得到，在「值」的 import 圖裡不會出現——
    // 這正是 spec 0008 §4 要的保證，所以改用另一個以值方式被 import 的 workspace 套件當哨兵。
    expect(visited.size).toBeGreaterThan(ADMIN_FILES.length);
    expect([...visited]).toContainEqual(join(ROOT, 'packages/platform/i18n/src/index.ts'));
    expect([...visited]).not.toContainEqual(join(ROOT, 'packages/commerce/order/src/http.ts'));
    expect(forbidden).toEqual([]);
  });
});

describe('reloadKey 這個平行實作不得回來（spec 0008 驗收）', () => {
  it('apps/admin/src 沒有任何檔案出現 reloadKey 這個識別字', () => {
    const offenders = ADMIN_FILES
      .filter((file) => /\breloadKey\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});

describe('這一輪不引入 TanStack Table、React Hook Form（spec 0008 §5/§6）', () => {
  const FORBIDDEN_PACKAGES = ['@tanstack/react-table', 'react-hook-form'];

  it('允許 @tanstack/react-query，不誤傷', () => {
    // 斷言常數陣列不含它只是重述自己；真正要證明的是它確實還在用，
    // 所以這條守衛若把 react-query 一起擋掉，這裡會先紅。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(declared)).toContain('@tanstack/react-query');
    expect(FORBIDDEN_PACKAGES.some((name) => '@tanstack/react-query'.startsWith(name))).toBe(false);
  });

  it('根 package.json 的 dependencies / devDependencies 不含這兩個套件', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    expect(FORBIDDEN_PACKAGES.filter((name) => declared.has(name))).toEqual([]);
  });

  it('apps/admin/src 沒有任何檔案 import 這兩個套件', () => {
    const offenders: string[] = [];
    for (const file of ADMIN_FILES) {
      for (const spec of importsOf(file)) {
        if (FORBIDDEN_PACKAGES.some((name) => spec === name || spec.startsWith(`${name}/`))) {
          offenders.push(`${relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
