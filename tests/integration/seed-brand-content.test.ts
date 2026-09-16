import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { seed } from '../../scripts/seeds/commerce';
import { createHarness, type TestHarness } from './helpers';

/**
 * seed 注入的品牌故事與生活誌沒有測試守住（ADR 0033 之後改由 content 模組管理）。
 * 這裡直接跑 demo seed，確認前台 `/story`、`/journal` 真的呈現得出來。
 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  await seed.demo(h.runtime);
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

describe('seed 品牌內容', () => {
  it('品牌故事出現在 /story', async () => {
    const response = await inject({ method: 'GET', url: '/story' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('為日常，採集一點剛好的溫度。');
  });

  it('三篇生活誌都出現在 /journal', async () => {
    const response = await inject({ method: 'GET', url: '/journal' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('為桌面留一塊空白');
    expect(response.body).toContain('讓物件與時間一起生活');
    expect(response.body).toContain('把家留得安靜一點');
    expect(response.body.match(/<article class="journal-card">/g) ?? []).toHaveLength(3);
  });
});
