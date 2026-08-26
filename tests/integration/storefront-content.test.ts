import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, type TestHarness } from './helpers';

/** 前台品牌內容與聯絡我們（Spec 0007）。 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);
const staff = { actor: ADMIN_ACTOR };

async function article(input: Record<string, unknown>, publish = true) {
  const created = await h.runtime.commands.execute<{ id: string; slug: string }>(
    'commerce.content.createArticle', input, { ...staff, idempotencyKey: randomUUID() });
  if (publish) await h.runtime.commands.execute('commerce.content.publishArticle', { id: created.id }, { ...staff, idempotencyKey: randomUUID() });
  return created;
}

describe('Spec 0007: 前台品牌內容', () => {
  it('沒有已發布內容時，品牌頁面全部是 404，聯絡我們仍然可用', async () => {
    for (const path of ['/story', '/journal', '/news', '/faq']) {
      expect((await inject({ method: 'GET', url: path })).statusCode).toBe(404);
    }
    expect((await inject({ method: 'GET', url: '/contact' })).statusCode).toBe(200);
  });

  it('發布之後前台讀得到，草稿不會外流，導覽列也長出入口', async () => {
    await article({
      kind: 'news', slug: 'holiday-shipping', section: '出貨公告', title: '連假期間的出貨安排',
      summary: '連假期間出貨會順延一個工作天。', body: [{ heading: null, text: '收假後依下單順序出貨。' }],
    });
    await article({
      kind: 'news', slug: 'not-ready-yet', title: '還沒寫完的公告',
      body: [{ heading: null, text: '這一則不該出現在前台。' }],
    }, false);

    const list = await inject({ method: 'GET', url: '/news' });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('連假期間的出貨安排');
    expect(list.body).not.toContain('還沒寫完的公告');

    const detail = await inject({ method: 'GET', url: '/news/holiday-shipping' });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('收假後依下單順序出貨。');

    expect((await inject({ method: 'GET', url: '/news/not-ready-yet' })).statusCode).toBe(404);

    expect((await inject({ method: 'GET', url: '/' })).body).toContain('href="/news"');
  });

  it('匿名訪客送得出聯絡訊息，honeypot 有值時回成功但不落表', async () => {
    const origin = 'http://localhost:3000';
    const before = await h.runtime.queries.execute<{ total: number }>('commerce.content.listContactMessages', {}, staff);

    const sent = await inject({
      method: 'POST', url: '/contact', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=林小姐&email=guest%40example.test&subject=出貨&message=可以指定到貨日嗎',
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('訊息已送出');

    const trapped = await inject({
      method: 'POST', url: '/contact', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=bot&email=bot%40example.test&subject=spam&message=spam&website=http%3A%2F%2Fspam.example',
    });
    expect(trapped.statusCode).toBe(200);
    expect(trapped.body).toContain('訊息已送出');

    const after = await h.runtime.queries.execute<{ items: any[]; total: number }>('commerce.content.listContactMessages', {}, staff);
    expect(after.total).toBe(before.total + 1);
    expect(after.items.map((m) => m.subject)).not.toContain('spam');
  });

  it('登入的顧客送出訊息時，訊息接得上他的顧客身分', async () => {
    const email = `contact-${randomUUID().slice(0, 8)}@example.com`;
    const registered = await inject({
      method: 'POST', url: '/api/v1/customers/register', payload: { email, password: 'a-good-password' },
    });
    const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const subject = `會員折扣-${randomUUID().slice(0, 6)}`;

    // A signed-in visitor posts with the CSRF field the page handed them; the
    // guard falls back to Origin only when there is no session at all.
    const page = await inject({ method: 'GET', url: '/contact', headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
    expect(csrf).toBeTruthy();

    const response = await inject({
      method: 'POST', url: '/contact',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      payload: new URLSearchParams({
        _csrf: csrf!, name: '王先生', email: 'member@example.test', subject, message: '升級之後折扣什麼時候生效？',
      }).toString(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('訊息已送出');

    const inbox = await h.runtime.queries.execute<{ items: any[] }>('commerce.content.listContactMessages', {}, staff);
    const mine = inbox.items.find((m) => m.subject === subject);
    expect(mine).toBeDefined();
    // The whole point of not using @Anonymous(): staff can see who asked.
    expect(mine.customerId).not.toBeNull();
  });

  it('缺少 Origin 的跨站送出被擋下', async () => {
    const response = await inject({
      method: 'POST', url: '/contact', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=a&email=a%40example.test&subject=b&message=c',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
