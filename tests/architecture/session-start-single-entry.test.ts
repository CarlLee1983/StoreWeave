import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSession } from '../../apps/api/src/http/session-start';
import { httpAdapter as baseAdapter } from '../../apps/api/src/releases/base';
import { httpAdapter as commerceAdapter } from '../../apps/api/src/releases/commerce';
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

  it('每個 release 接上的就是那一份實作，不是自己另外組一個', () => {
    // 比對值而不是比對字串：import 了再指派一個自己寫的函式，文字檢查看不出來。
    expect(baseAdapter.startSession).toBe(startSession);
    expect(commerceAdapter.startSession).toBe(startSession);
    expect(releaseFiles).toHaveLength(2);
  });

  it('只有簽發實作本身可以寫 session cookie', () => {
    // 只禁 setSessionCookies（簽發），不禁 clearSessionCookies——登出本來就要清 cookie。
    const offenders = files
      .filter(file => file !== IMPLEMENTATION && file !== 'http/session-cookies.ts')
      .filter(file => /\bsetSessionCookies\b/.test(readFileSync(join(ROOT, API_SRC, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
