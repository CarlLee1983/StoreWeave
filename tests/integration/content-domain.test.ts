import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import { contentArticles, contentContactMessages, contentLegacyMediaMappings, contentMigrations, LegacyContentMediaBackfill } from '@storeweave/content';
import { ADMIN_ACTOR, STOREFRONT_ACTOR, createHarness, createTestDatabase, defaultCustomer, runJobsUntilProcessed, type TestHarness } from './helpers';
import { Client } from 'pg';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

let h: TestHarness;
let storageRoot: string;
beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'storeweave-content-media-'));
  h = await createHarness({ storageRoot });
}, 300_000);
afterAll(async () => {
  await h?.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

const draft = (over: Record<string, unknown> = {}) => ({
  kind: 'news', slug: `notice-${randomUUID().slice(0, 8)}`, title: '出貨公告', summary: '連假期間的出貨安排',
  section: '店務公告', body: [{ heading: null, text: '連假期間出貨會順延一個工作天。' }], ...over,
});
const create = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.content.createArticle', input, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
const publish = (id: string) =>
  h.runtime.commands.execute<any>('commerce.content.publishArticle', { id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
const published = (kind: string) =>
  h.runtime.queries.execute<any>('commerce.content.listPublishedArticles', { kind }, { actor: STOREFRONT_ACTOR });

describe('Spec 0007: 品牌內容與聯絡我們', () => {
  it('草稿不出現在前台，發布之後才出現，收回草稿又消失', async () => {
    const article = await create(draft());
    expect(article.status).toBe('draft');
    expect(article.publishedAt).toBeNull();
    expect((await published('news')).items.map((a: any) => a.id)).not.toContain(article.id);
    await expect(h.runtime.queries.execute('commerce.content.getPublishedArticle', { kind: 'news', slug: article.slug }, { actor: STOREFRONT_ACTOR })).rejects.toThrow(/Article/);

    const live = await publish(article.id);
    expect(live.publishedAt).not.toBeNull();
    expect((await published('news')).items.map((a: any) => a.id)).toContain(article.id);
    expect((await h.runtime.queries.execute<any>('commerce.content.getPublishedArticle', { kind: 'news', slug: article.slug }, { actor: STOREFRONT_ACTOR })).title).toBe('出貨公告');

    await h.runtime.commands.execute('commerce.content.unpublishArticle', { id: article.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect((await published('news')).items.map((a: any) => a.id)).not.toContain(article.id);
  });

  it('重複發布是無操作，不是錯誤，也不重寫發布時間', async () => {
    const article = await publish((await create(draft())).id);
    const again = await publish(article.id);
    expect(again.publishedAt).toEqual(article.publishedAt);
  });

  it('同一 kind 的 slug 不能重複，不同 kind 可以共用同一個 slug', async () => {
    const slug = `shared-${randomUUID().slice(0, 8)}`;
    await create(draft({ slug }));
    await expect(create(draft({ slug }))).rejects.toThrow(/already used/);
    await expect(create(draft({ kind: 'faq', slug, title: '可以退貨嗎？' }))).resolves.toBeTruthy();
  });

  it('前台依 position 排序，相同時才看發布時間', async () => {
    const kind = 'faq';
    const before = new Set((await published(kind)).items.map((a: any) => a.id));
    const last = await publish((await create(draft({ kind, position: 20, title: '最後' }))).id);
    const first = await publish((await create(draft({ kind, position: 1, title: '最先' }))).id);
    const order = (await published(kind)).items.filter((a: any) => !before.has(a.id)).map((a: any) => a.id);
    expect(order).toEqual([first.id, last.id]);
  });

  it('storefront 角色讀不到草稿，也寫不了內容', async () => {
    await expect(h.runtime.queries.execute('commerce.content.listArticles', { kind: 'news' }, { actor: STOREFRONT_ACTOR })).rejects.toThrow();
    await expect(h.runtime.commands.execute('commerce.content.createArticle', draft(), { actor: STOREFRONT_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow();
  });

  it('slug 與 image key 只收小寫連字號格式，空白內文也被擋下', async () => {
    await expect(create(draft({ slug: 'Not A Slug' }))).rejects.toThrow(/Invalid input/);
    await expect(create(draft({ imageKey: '../etc/passwd' }))).rejects.toThrow(/Invalid input/);
    await expect(create(draft({ body: [{ heading: null, text: '   ' }] }))).rejects.toThrow(/Invalid input/);
  });

  it('品牌故事的章節標題原樣存回，段落順序不變', async () => {
    const created = await create(draft({
      kind: 'story', slug: `story-${randomUUID().slice(0, 8)}`, title: '為日常，採集一點剛好的溫度。',
      body: [
        { heading: null, text: '從每天會碰觸的事物開始。' },
        { heading: '從手邊開始', text: '一只杯、一塊布、一張托盤。' },
        { heading: '替留白保留位置', text: '好的物件不需要搶走空間的聲音。' },
      ],
    }));
    expect(created.body).toEqual([
      { heading: null, text: '從每天會碰觸的事物開始。' },
      { heading: '從手邊開始', text: '一只杯、一塊布、一張托盤。' },
      { heading: '替留白保留位置', text: '好的物件不需要搶走空間的聲音。' },
    ]);
  });

  it('刪除後前台與後台都查不到', async () => {
    const article = await publish((await create(draft())).id);
    await h.runtime.commands.execute('commerce.content.deleteArticle', { id: article.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect((await published('news')).items.map((a: any) => a.id)).not.toContain(article.id);
    await expect(h.runtime.queries.execute('commerce.content.getArticle', { id: article.id }, { actor: ADMIN_ACTOR })).rejects.toThrow(/Article/);
  });

  it('ready B10 media is bound transactionally, is public only after publishing, and is released on article deletion', async () => {
    const article = await create(draft({ imageKey: null }));
    const asset = await h.runtime.media.upload({ stream: Readable.from(PNG), originalName: 'content.png', contentType: 'image/png', ownerActorId: ADMIN_ACTOR.id });
    await runJobsUntilProcessed(h.worker);
    await h.runtime.commands.execute('commerce.content.setArticleMedia', { id: article.id, mediaAssetId: asset.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(h.runtime.queries.execute('commerce.content.getPublishedMedia', { mediaAssetId: asset.id }, { actor: STOREFRONT_ACTOR })).rejects.toThrow();
    await publish(article.id);
    await expect(h.runtime.queries.execute('commerce.content.getPublishedMedia', { mediaAssetId: asset.id }, { actor: STOREFRONT_ACTOR })).resolves.toEqual({ mediaAssetId: asset.id });
    await h.runtime.commands.execute('commerce.content.deleteArticle', { id: article.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(h.runtime.media.remove(asset.id)).resolves.toBeUndefined();
  });

  it('匿名訪客送得出訊息，登入顧客的訊息帶得出身分，重複標記已處理被擋下', async () => {
    const message = await h.runtime.commands.execute<any>('commerce.content.submitContactMessage',
      { name: '林小姐', email: 'guest@example.com', subject: '可以指定出貨日嗎？', message: '想約在下週三之後。' },
      { actor: STOREFRONT_ACTOR, idempotencyKey: randomUUID() });
    expect(message.status).toBe('new');
    expect(message.customerId).toBeNull();

    const customer = await defaultCustomer(h.runtime);
    const signed = await h.runtime.commands.execute<any>('commerce.content.submitContactMessage',
      { name: '王先生', email: 'member@example.com', subject: '會員折扣', message: '升級之後折扣什麼時候生效？' },
      { actor: customer, idempotencyKey: randomUUID() });
    expect(signed.customerId).not.toBeNull();

    const inbox = await h.runtime.queries.execute<any>('commerce.content.listContactMessages', { status: 'new' }, { actor: ADMIN_ACTOR });
    expect(inbox.items.map((m: any) => m.id)).toEqual(expect.arrayContaining([message.id, signed.id]));

    const handled = await h.runtime.commands.execute<any>('commerce.content.markContactMessageHandled', { id: message.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect(handled.status).toBe('handled');
    expect(handled.handledAt).not.toBeNull();
    await expect(h.runtime.commands.execute('commerce.content.markContactMessageHandled', { id: message.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/already handled/);
  });

  it('訪客讀不到收件匣', async () => {
    await expect(h.runtime.queries.execute('commerce.content.listContactMessages', {}, { actor: STOREFRONT_ACTOR })).rejects.toThrow();
  });

  it('old 0001 content data upgrades in place: article and contact identities survive 0002', async () => {
    const database = new Client({ connectionString: await createTestDatabase() });
    await database.connect();
    try {
      const articleId = randomUUID();
      const messageId = randomUUID();
      await database.query(contentMigrations.migrations[0]!.up);
      await database.query(
        `INSERT INTO content_articles (id, kind, slug, title, summary, section, body, image_key)
         VALUES ($1, 'news', 'pre-b14-news', 'Old article', 'Existing summary', 'News', '[]'::jsonb, 'old-news-image')`, [articleId],
      );
      await database.query(
        `INSERT INTO content_contact_messages (id, name, email, subject, message)
         VALUES ($1, 'Old visitor', 'old@example.test', 'Existing contact', 'Keep this message')`, [messageId],
      );
      await database.query(contentMigrations.migrations[1]!.up);
      const article = await database.query<{ id: string; slug: string; image_key: string; media_asset_id: string | null }>(
        'SELECT id, slug, image_key, media_asset_id FROM content_articles WHERE id = $1', [articleId],
      );
      const message = await database.query<{ id: string; subject: string }>(
        'SELECT id, subject FROM content_contact_messages WHERE id = $1', [messageId],
      );
      expect(article.rows).toEqual([{ id: articleId, slug: 'pre-b14-news', image_key: 'old-news-image', media_asset_id: null }]);
      expect(message.rows).toEqual([{ id: messageId, subject: 'Existing contact' }]);
      await expect(database.query(
        `INSERT INTO content_legacy_media_mappings (theme_id, image_key, source_digest, media_asset_id, status)
         VALUES ('default', 'old-news-image', '${'a'.repeat(64)}', $1, 'pending')`, [randomUUID()],
      )).resolves.toBeDefined();
    } finally {
      await database.end();
    }
  });

  it('records a failed legacy import, resumes it after the source is fixed, and attaches its ready B10 asset', async () => {
    const imageKey = `b14-legacy-${randomUUID().slice(0, 8)}`;
    const article = await create(draft({ imageKey }));
    const entry = {
      themeId: 'default', imageKey, file: 'legacy.png', altText: 'Legacy content image',
      sourceDigest: createHash('sha256').update(PNG).digest('hex'),
    };
    let sourceBytes = Buffer.from('corrupt legacy bytes');
    const backfill = new LegacyContentMediaBackfill(h.runtime.database, h.runtime.media, h.runtime.media.references, {
      open: async () => ({ stream: Readable.from([sourceBytes]), contentType: 'image/png' }),
    });
    await expect(backfill.run([entry])).resolves.toMatchObject({ imported: 0, waiting: 0, attached: 0, failed: [{ imageKey }] });

    sourceBytes = PNG;
    await expect(backfill.run([entry])).resolves.toEqual({ imported: 1, waiting: 1, attached: 0, failed: [] });
    expect(await runJobsUntilProcessed(h.worker)).toMatchObject({ processed: 1, failed: 0 });
    await expect(backfill.run([entry])).resolves.toEqual({ imported: 0, waiting: 0, attached: 1, failed: [] });
    const attached = await h.runtime.queries.execute<any>('commerce.content.getArticle', { id: article.id }, { actor: ADMIN_ACTOR });
    expect(attached.mediaAssetId).toMatch(/[0-9a-f-]{36}/);
    await expect(backfill.reconcile([entry])).resolves.toEqual({ unmappedKeys: [], incompleteKeys: [] });
  });

  /**
   * schema.ts 的 Drizzle 定義與 migrations.ts 的 SQL 是兩份各自手維護的真相
   * （ADR 0008：migration 內嵌在 TypeScript，沒有產生器）。沒有這個測試，
   * 兩邊漂移只會在某一次查詢炸掉時才被發現。
   */
  it.each([
    ['content_articles', contentArticles],
    ['content_contact_messages', contentContactMessages],
    ['content_legacy_media_mappings', contentLegacyMediaMappings],
  ])('%s 的實際欄位與 Drizzle 定義一致', async (tableName, table) => {
    const actual = await h.runtime.database.db.execute<{ column_name: string; is_nullable: string }>(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = ${tableName} ORDER BY column_name
    `);
    const declared = Object.values(getTableColumns(table as any))
      .map((column: any) => ({ column_name: column.name, is_nullable: column.notNull ? 'NO' : 'YES' }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(actual.rows).toEqual(declared);
  });

  it('已發布必定有發布時間，這條不變式由資料庫自己守住', async () => {
    const article = await create(draft());
    await expect(h.runtime.database.db.execute(sql`
      UPDATE content_articles SET status = 'published' WHERE id = ${article.id}
    `)).rejects.toThrow();
  });
});
