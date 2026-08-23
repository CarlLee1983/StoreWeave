import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Dockerfile 的 builder 階段只先帶進每一個 workspace 的 manifest，讓 `pnpm install`
 * 這一層吃得到 layer cache。少帶一個的代價不是「那個套件裝不到」——
 * lockfile 裡會有一個找不到 manifest 的 importer，pnpm 於是放棄 frozen lockfile
 * 改成整包重解，開始下載所有平台的 esbuild／rollup，然後在 CI 上卡到逾時。
 *
 * 這在 pnpm 10 走得過去（那時 lockfile 根本沒有那些 importer 條目），升到 11 才炸開來。
 * 判準對齊真正的邊界：實際存在的 workspace 目錄，不是誰記得改這份清單。
 */
/** vitest 從 repo 根目錄跑，`import.meta` 在這份 tsconfig 的 module 設定下不合法。 */
const ROOT = process.cwd();

function workspaceManifests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const relative = `${dir}/${entry}`;
    if (!statSync(join(ROOT, relative)).isDirectory()) continue;
    try {
      statSync(join(ROOT, relative, 'package.json'));
      found.push(`${relative}/package.json`);
    } catch {
      workspaceManifests(relative, found);
    }
  }
  return found;
}

describe('Dockerfile 的 workspace manifest 清單', () => {
  it('與實際存在的 workspace 一一對應', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const copied = new Set(
      [...dockerfile.matchAll(/^COPY (\S+\/package\.json) /gm)].map((m) => m[1]),
    );

    const actual = ['apps', 'packages', 'tools'].flatMap((dir) => workspaceManifests(dir)).sort();
    // 掃不到東西的測試會永遠是綠的。
    expect(actual.length).toBeGreaterThan(20);

    expect(actual.filter((manifest) => !copied.has(manifest))).toEqual([]);
    expect([...copied].filter((manifest) => !actual.includes(manifest))).toEqual([]);
  });
});
