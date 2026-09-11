import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession } from '../../apps/api/src/http/session-start';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import { ROOT, importsOf, sourceFiles } from './source-graph';

/**
 * 簽發 session 的實作只能由 release adapter 接上去，其他呼叫端一律經過注入的 adapter。
 *
 * 這不是潔癖：ADR 0047 把「請簽發 session」變成頁面的 outcome，而路由層要執行它就得知道
 * 這個 release 要不要合併訪客購物車。呼叫端直接引用實作就繞過了那個決定——形象站那份
 * 不合併購物車的重複實作當初就是這樣長出來而沒被發現的（工單 92）。
 */
const API_SRC = 'apps/api/src';
const IMPLEMENTATION = 'http/session-start.ts';
const releaseFiles = readdirSync(join(ROOT, API_SRC, 'releases')).map(file => `releases/${file}`);
const files = sourceFiles(API_SRC).map(file => relative(join(ROOT, API_SRC), file));

describe('簽發 session 的唯一入口', () => {
  it('掃描到 apps/api 的原始碼', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(IMPLEMENTATION);
  });

  it('只有 release adapter 可以引用實作，其他人走注入的 adapter', () => {
    const offenders = files
      .filter(file => file !== IMPLEMENTATION && !releaseFiles.includes(file))
      .filter(file => importsOf(join(ROOT, API_SRC, file)).some(spec => spec.endsWith('session-start')));

    expect(offenders).toEqual([]);
  });

  it('每個 release 接上的就是那一份實作，不是自己另外組一個', async () => {
    // 比對值而不是比對字串：import 了再指派一個自己寫的函式，文字檢查看不出來。
    // 逐一載入目錄裡的每個 release，新增 release 不必回來改這條守衛。
    expect(releaseFiles).toEqual(expect.arrayContaining(['releases/base.ts', 'releases/commerce.ts']));
    for (const release of releaseFiles) {
      const { httpAdapter } = await import(join(ROOT, API_SRC, release)) as { httpAdapter: ReleaseHttpAdapter };
      expect(httpAdapter.startSession, release).toBe(startSession);
    }
  }, 30_000);

  it('只有具名的那兩份實作可以直接動 session cookie', () => {
    // 簽發與清除各有唯一實作，其他人呼叫它們而不是自己寫一份。
    const owners: Record<string, string[]> = {
      setSessionCookies: [IMPLEMENTATION, 'http/session-cookies.ts'],
      clearSessionCookies: ['http/session-clear.ts', 'http/session-cookies.ts'],
    };

    for (const [helper, allowed] of Object.entries(owners)) {
      const offenders = files
        .filter(file => !allowed.includes(file))
        .filter(file => new RegExp(`\\b${helper}\\b`).test(readFileSync(join(ROOT, API_SRC, file), 'utf8')));

      expect(offenders, helper).toEqual([]);
    }
  });

  it('每個 release 把頁面用的簽發接到自己的 adapter 上，不是接自由變數', () => {
    // 值比對只釘得住 adapter 對外那一份；頁面走的是 sessionEffects.start，那是第二條接線。
    // 只換 release id、完全沿用 base 組裝的 release 沒有自己的 controllers 也不碰 startSession，
    // 它的接線就是 base 那一份（呼叫時 this 指向自己）。自己組 controllers 的一律要自己接。
    for (const release of releaseFiles) {
      const body = readFileSync(join(ROOT, API_SRC, release), 'utf8');
      const wiresItself = /start:\s*\([^)]*\)\s*=>\s*this\.startSession\(/.test(body);
      const delegatesToBase = /from '\.\/base'/.test(body) && /\.\.\.baseHttpAdapter/.test(body)
        && !/controllers\s*[(:]/.test(body) && !/startSession/.test(body);
      expect(wiresItself || delegatesToBase, release).toBe(true);
    }
  });
});
