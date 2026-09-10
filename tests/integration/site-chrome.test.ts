import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Runtime } from '@storeweave/kernel';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';

/**
 * 網站設定與導覽是資料，獨立於 theme（ADR 0046）。跑在 base release 上是刻意的：
 * 它證明這條路徑不需要任何商務模組。
 */
process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');

const runtimes: Runtime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-site-'));
  directories.push(directory);
  const configPath = join(directory, 'config.yaml');
  writeFileSync(configPath, JSON.stringify({
    version: 1, store: { id: 'site-test', name: '網站測試', locale: 'zh-TW' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
    storage: { localRoot: join(directory, 'storage') },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  const result = await bootstrapRelease(baseRelease, { configPath, loggerName: 'site-test' });
  runtimes.push(result.runtime);
  await result.runtime.migrate();
  const app = await createReleaseServer({
    runtime: result.runtime, theme: result.theme, httpAdapter,
    release: { version: baseRelease.version, configPath: result.loaded.sourcePath },
  });
  return { runtime: result.runtime, app };
}

describe('site settings and navigation', () => {
  it('renders the release default navigation while the table is empty', async () => {
    const { runtime, app } = await start();
    try {
      const home = await app.inject({ url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('<a href="/">首頁</a>');
      // 預設值不是 migration 塞進去的資料列，所以表是空的（ADR 0046）。
      const rows = await runtime.database.pool.query('SELECT id FROM platform_site_navigation_items');
      expect(rows.rows).toEqual([]);
    } finally { await app.close(); }
  });

  it('lets an operator replace one menu and edit the tagline, and shows it on the next request', async () => {
    const { runtime, app } = await start();
    try {
      await runtime.commands.execute('platform.site.updateSettings',
        { tagline: '一個沒有商務的網站', footerNote: '頁尾附註' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
      await runtime.commands.execute('platform.site.replaceNavigation', {
        menu: 'primary',
        items: [
          { groupLabel: null, label: '關於我們', href: '/about', position: 10, requiresContentKind: null },
          { groupLabel: null, label: '首頁', href: '/', position: 0, requiresContentKind: null },
        ],
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

      const home = await app.inject({ url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('一個沒有商務的網站');
      expect(home.body).toContain('頁尾附註');
      // position 決定順序，不是送出的順序。
      expect(home.body).toContain('<a href="/">首頁</a><a href="/about">關於我們</a>');
    } finally { await app.close(); }
  });

  it('refuses a navigation href that leaves the site', async () => {
    const { runtime, app } = await start();
    try {
      await expect(runtime.commands.execute('platform.site.replaceNavigation', {
        menu: 'primary',
        items: [{ groupLabel: null, label: '外站', href: 'https://evil.example', position: 0, requiresContentKind: null }],
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally { await app.close(); }
  });

  it('keeps each theme visual options separate', async () => {
    const { runtime, app } = await start();
    try {
      // bootstrap 只驗證並回寫目前選用的那一組，其他 theme 的設定原封留著（ADR 0045）。
      expect(runtime.config.theme.id).toBe('base');
      expect(runtime.config.theme.options).toEqual({ base: { accentColor: '#2F5D62' } });
    } finally { await app.close(); }
  });
});
