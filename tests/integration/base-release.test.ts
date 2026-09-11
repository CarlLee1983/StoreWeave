import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { csrfTokenFor } from '@storeweave/identity';
import { ADMIN_ACTOR } from './helpers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import type { Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const runtimes: Runtime[] = [];
const directories: string[] = [];
process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function configPath() {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-release-'));
  directories.push(directory);
  const config = join(directory, 'config.yaml');
  writeFileSync(config, JSON.stringify({
    version: 1, store: { id: 'release-test', name: 'Release Test' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
    storage: { localRoot: join(directory, 'storage'), maxUploadBytes: 1024 },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  return config;
}

describe('selected release bootstrap', () => {
  it('Base starts and migrates without currency or Commerce modules, and brings its own site theme', async () => {
    const result = await bootstrapRelease(baseRelease, { configPath: await configPath(), loggerName: 'base-test' });
    const { runtime } = result;
    runtimes.push(runtime);
    // base 也是一個網站：site 模組帶來設定與導覽，base theme 只實作通用頁（ADR 0046）。
    expect(result.theme?.id).toBe('base');
    expect(runtime.config.store).not.toHaveProperty('currency');
    expect(runtime.modules.map(module => module.name).sort()).toEqual(['content', 'platform', 'platform-auth', 'platform-cache', 'platform-identity', 'platform-mail', 'platform-media', 'platform-notifications', 'platform-ops', 'platform-site', 'platform-storage']);
    expect(Object.keys(runtime.roles).sort()).toEqual(['admin', 'member', 'readonly', 'staff', 'visitor']);
    await runtime.migrate();
    await expect(runtime.migrate()).resolves.toEqual([]);
    const tables = await runtime.database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map(row => row.tablename)).toEqual([
      'content_articles', 'content_contact_messages', 'content_legacy_media_mappings',
      'platform_api_tokens', 'platform_audit_log', 'platform_cache', 'platform_extension_registry', 'platform_extension_state',
      'platform_idempotency', 'platform_identity_tokens', 'platform_job_quarantine', 'platform_job_schedules', 'platform_jobs', 'platform_mail_messages',
      'platform_media_assets', 'platform_media_references', 'platform_mfa_recovery_codes', 'platform_migration_baselines', 'platform_migrations',
      'platform_notification_deliveries', 'platform_notifications', 'platform_outbox',
      'platform_outbox_quarantine', 'platform_outbox_quarantine_audit',
      'platform_release_history', 'platform_sessions', 'platform_site_navigation_items', 'platform_site_settings',
      'platform_storage_objects', 'platform_user_mfa', 'platform_users', 'platform_worker_heartbeat',
    ]);
  });

  it('Base storefront lets Members register, log in, reset their password, and log out without Commerce', async () => {
    const result = await bootstrapRelease(baseRelease, { configPath: await configPath(), loggerName: 'base-member-auth' });
    const { runtime } = result;
    runtimes.push(runtime);
    await runtime.migrate();
    const app = await createReleaseServer({ runtime, theme: result.theme, httpAdapter,
      release: { version: baseRelease.version, configPath: result.loaded.sourcePath } });
    const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
    try {
      for (const url of ['/login', '/register', '/forgot-password', '/reset-password?token=example']) {
        expect((await app.inject({ url })).statusCode, url).toBe(200);
      }

      const registered = await app.inject({
        method: 'POST', url: '/register', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ email: 'member@example.com', password: 'member-password-1', displayName: 'Base Member', next: '/' }),
      });
      expect(registered.statusCode).toBe(303);
      const firstSession = registered.cookies.find(cookie => cookie.name === SESSION_COOKIE)?.value;
      expect(firstSession).toBeDefined();
      expect((await runtime.auth.resolveSession(runtime.database.db, firstSession!))?.user.role).toBe('member');
      expect(runtime.modules.map(module => module.name)).not.toContain('cart');

      const loggedOut = await app.inject({
        method: 'POST', url: '/logout', cookies: { [SESSION_COOKIE]: firstSession! },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ _csrf: csrfTokenFor(firstSession!) }),
      });
      expect(loggedOut.statusCode).toBe(303);

      const loggedIn = await app.inject({
        method: 'POST', url: '/login', cookies: { commerce_cart: 'a-guest-cart-token-from-somewhere' },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ email: 'member@example.com', password: 'member-password-1', next: '/' }),
      });
      expect(loggedIn.statusCode).toBe(303);
      expect(loggedIn.cookies.find(cookie => cookie.name === 'commerce_cart')).toBeUndefined();

      const requested = await app.inject({
        method: 'POST', url: '/forgot-password', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ email: 'member@example.com' }),
      });
      expect(requested.statusCode).toBe(200);
      expect(requested.body).toContain('若這個電子郵件存在');
      const mail = await runtime.database.db.execute<{ text_body: string }>(sql`
        SELECT text_body FROM platform_mail_messages
        WHERE template_id = 'identity.password-reset' ORDER BY created_at DESC LIMIT 1
      `);
      const token = new URL(/https?:\/\/\S+/.exec(mail.rows[0]!.text_body)![0]).searchParams.get('token')!;
      const reset = await app.inject({
        method: 'POST', url: '/reset-password', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ token, password: 'member-password-2' }),
      });
      expect(reset.statusCode).toBe(303);
      expect(reset.headers.location).toBe('/login');
      expect((await app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ email: 'member@example.com', password: 'member-password-1' }) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ email: 'member@example.com', password: 'member-password-2' }) })).statusCode).toBe(303);
    } finally { await app.close(); }
  });

  it('Base HTTP authenticates with Base permissions, renders its own storefront, and exposes no Commerce routes', async () => {
    const result = await bootstrapRelease(baseRelease, { configPath: await configPath(), loggerName: 'base-http' });
    const { runtime } = result;
    runtimes.push(runtime);
    await runtime.migrate();
    const password = 'base-http-passphrase';
    await runtime.commands.execute('platform.identity.createUser', {
      email: 'base@example.com', password, displayName: 'Base Operator', role: 'staff',
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const issued = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx, {
      name: 'readonly', role: 'readonly', ttlMs: 60 * 60_000,
    }));
    const app = await createReleaseServer({ runtime, theme: result.theme, httpAdapter,
      release: { version: baseRelease.version, configPath: result.loaded.sourcePath } });
    try {
      expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/system/jobs/dead' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/system/jobs/dead',
        headers: { authorization: `Bearer ${issued.secret}` } })).statusCode).toBe(200);
      for (const url of ['/api/v1/products', '/api/v1/orders', '/mcp', '/storefront-assets/woven-day-hero.png']) {
        expect((await app.inject({ url })).statusCode, url).toBe(404);
      }
      // 一個沒有商務模組的 release 渲染得出可瀏覽的網站，導覽來自 release 預設值（ADR 0046）。
      const home = await app.inject({ url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toContain('text/html');
      expect(home.body).toContain('<a href="/">首頁</a>');
      expect(home.body).toContain('Release Test');
      // Content is a website module: an empty base site still accepts contact
      // messages while unpublished editorial routes remain absent.
      expect((await app.inject({ url: '/news' })).statusCode).toBe(404);
      const contact = await app.inject({
        method: 'POST', url: '/contact', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'name=Visitor&email=visitor%40example.test&subject=Hello&message=Base+content+works',
      });
      expect(contact.statusCode).toBe(200);
      expect(contact.body).toContain('訊息已送出');
      const inbox = await runtime.queries.execute<{ total: number }>('commerce.content.listContactMessages', {}, {
        actor: runtime.actorForRole('staff'), channel: 'rest',
      });
      expect(inbox.total).toBe(1);
      // 形象站與購物站共用同一份簽發實作（工單 92）：帶著購物車 cookie 進來也不會有東西可以併，
      // 因為這個 release 根本沒有註冊那個 command——而且不能因此在 log 裡留下失敗。
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { email: 'base@example.com', password },
        cookies: { commerce_cart: 'a-guest-cart-token-from-somewhere' } });
      expect(login.statusCode).toBe(200);
      expect(login.json().data).toMatchObject({ role: 'staff', cartNotice: null });
      const cookie = login.cookies.find(cookie => cookie.name === SESSION_COOKIE);
      expect(cookie).toBeDefined();
      const me = await app.inject({ url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: cookie!.value } });
      expect(me.statusCode).toBe(200);
      expect(me.json().data.role).toBe('staff');
      // 後台的側欄靠這兩份清單決定列出哪幾頁（B13 片3）。
      expect(me.json().data.permissions).toContain('jobs:read');
      expect(me.json().data.permissions).not.toContain('*');
      expect(me.json().data.modules).toContain('platform-site');

      // B14's public projection must be an actual HTTP boundary: a ready
      // asset remains private while its article is a draft, then becomes
      // readable only through the content-owned preview after publishing.
      const csrf = csrfTokenFor(cookie!.value);
      const staffHeaders = { 'x-csrf-token': csrf };
      const article = await app.inject({
        method: 'POST', url: '/api/v1/content/articles', cookies: { [SESSION_COOKIE]: cookie!.value },
        headers: { ...staffHeaders, 'idempotency-key': 'base-b14-create' },
        payload: { kind: 'news', slug: 'base-b14-published', title: 'Published Base Article', summary: 'Visible only after publishing.' },
      });
      expect(article.statusCode).toBe(200);
      const mediaAsset = await runtime.media.upload({
        stream: Readable.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')),
        originalName: 'base-content.png', contentType: 'image/png', ownerActorId: 'user:base',
      });
      await runtime.media.process({ assetId: mediaAsset.id, generation: mediaAsset.generation }, { signal: new AbortController().signal });
      const setMedia = await app.inject({
        method: 'POST', url: `/api/v1/content/articles/${article.json().data.id}/media`, cookies: { [SESSION_COOKIE]: cookie!.value },
        headers: { ...staffHeaders, 'idempotency-key': 'base-b14-set-media' }, payload: { mediaAssetId: mediaAsset.id },
      });
      expect(setMedia.statusCode).toBe(200);
      expect((await app.inject({ url: `/content/media/${mediaAsset.id}/preview` })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v1/media/${mediaAsset.id}/preview` })).statusCode).toBe(401);
      expect((await app.inject({
        method: 'POST', url: `/api/v1/content/articles/${article.json().data.id}/publish`, cookies: { [SESSION_COOKIE]: cookie!.value },
        headers: { ...staffHeaders, 'idempotency-key': 'base-b14-publish' },
      })).statusCode).toBe(200);
      const publicMedia = await app.inject({ url: `/content/media/${mediaAsset.id}/preview` });
      expect(publicMedia.statusCode).toBe(200);
      expect(publicMedia.headers['content-type']).toContain('image/webp');
      for (const url of ['/robots.txt', '/sitemap.xml', '/rss.xml']) expect((await app.inject({ url })).statusCode, url).toBe(200);
      const sitemap = await app.inject({ url: '/sitemap.xml' });
      const rss = await app.inject({ url: '/rss.xml' });
      expect(sitemap.body).toContain('/news/base-b14-published');
      expect(rss.body).toContain('Published Base Article');

      // The notification recipient is operator configuration, not public
      // chrome. The API provides a deployable way to set it; a missing value
      // intentionally creates no notification, while a configured value does.
      const anonymousContact = (subject: string) => app.inject({
        method: 'POST', url: '/contact', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
        payload: `name=Visitor&email=visitor%40example.test&subject=${encodeURIComponent(subject)}&message=Contact+notification+test`,
      });
      expect((await anonymousContact('No recipient')).statusCode).toBe(200);
      expect((await runtime.database.pool.query("SELECT count(*)::text AS count FROM platform_notifications WHERE template_id = 'site.contact.submitted'"))
        .rows[0]?.count).toBe('0');
      const settings = await app.inject({
        method: 'POST', url: '/api/v1/site/settings', cookies: { [SESSION_COOKIE]: cookie!.value },
        headers: { ...staffHeaders, 'idempotency-key': 'base-b14-contact-recipient' }, payload: { contactNotificationEmail: 'editor@example.test' },
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().data.contactNotificationEmail).toBe('editor@example.test');
      const chrome = await runtime.queries.execute<{ settings: Record<string, unknown> }>('platform.site.getChrome', {}, { actor: runtime.actorForRole('visitor') });
      expect(chrome.settings).not.toHaveProperty('contactNotificationEmail');
      expect((await anonymousContact('Configured recipient')).statusCode).toBe(200);
      const notification = await runtime.database.pool.query<{ recipient_email: string; template_id: string }>(
        "SELECT recipient_email, template_id FROM platform_notifications WHERE template_id = 'site.contact.submitted'",
      );
      expect(notification.rows).toEqual([{ recipient_email: 'editor@example.test', template_id: 'site.contact.submitted' }]);
      const audit = await runtime.database.pool.query<{ payload: { contactNotificationEmail: string } }>(
        "SELECT payload FROM platform_audit_log WHERE action = 'site.settings.updated' ORDER BY occurred_at DESC LIMIT 1",
      );
      expect(audit.rows[0]?.payload.contactNotificationEmail).toBe('[configured]');

      const boundary = 'b09-test-boundary';
      const upload = await app.inject({
        method: 'POST', url: '/api/v1/storage/objects',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrfTokenFor(cookie!.value) },
        cookies: { [SESSION_COOKIE]: cookie!.value },
        payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nbase storage\r\n--${boundary}--\r\n`),
      });
      expect(upload.statusCode).toBe(201);
      const object = upload.json().data as { id: string; sha256: string };
      const content = await app.inject({ url: `/api/v1/storage/objects/${object.id}/content`, cookies: { [SESSION_COOKIE]: cookie!.value } });
      expect(content.statusCode).toBe(200);
      expect(content.body).toBe('base storage');
      expect(content.headers.etag).toBe(`"${object.sha256}"`);
      const rejected = await app.inject({
        method: 'POST', url: '/api/v1/storage/objects',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrfTokenFor(cookie!.value) },
        cookies: { [SESSION_COOKIE]: cookie!.value },
        payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(1025)}\r\n--${boundary}--\r\n`),
      });
      expect(rejected.statusCode).not.toBe(201);
      const listed = await app.inject({ url: '/api/v1/storage/objects', cookies: { [SESSION_COOKIE]: cookie!.value } });
      expect(listed.json().data.items).toHaveLength(1);

      // Media is a separate policy boundary: readonly can browse it, while the
      // generic storage permissions do not grant upload or deletion authority.
      const readonlyMedia = await app.inject({ url: '/api/v1/media', headers: { authorization: `Bearer ${issued.secret}` } });
      expect(readonlyMedia.statusCode).toBe(200);
      const mediaBoundary = 'b10-test-boundary';
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      const mediaUpload = await app.inject({
        method: 'POST', url: '/api/v1/media', cookies: { [SESSION_COOKIE]: cookie!.value },
        headers: { 'content-type': `multipart/form-data; boundary=${mediaBoundary}`, 'x-csrf-token': csrfTokenFor(cookie!.value) },
        payload: Buffer.concat([Buffer.from(`--${mediaBoundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.from(png, 'base64'), Buffer.from(`\r\n--${mediaBoundary}--\r\n`)]),
      });
      expect(mediaUpload.statusCode).toBe(202);
      expect(mediaUpload.json().data).toMatchObject({ status: 'pending', altText: '' });
      const forbiddenWrite = await app.inject({ method: 'POST', url: '/api/v1/media', headers: {
        authorization: `Bearer ${issued.secret}`, 'content-type': `multipart/form-data; boundary=${mediaBoundary}`,
      }, payload: Buffer.from(`--${mediaBoundary}--\r\n`) });
      expect(forbiddenWrite.statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('Commerce selects its original modules and default theme through the same bootstrap', async () => {
    const result = await bootstrapRelease(commerceRelease, { configPath: await configPath(), loggerName: 'commerce-test' });
    runtimes.push(result.runtime);
    expect(result.theme?.id).toBe('default');
    expect(result.runtime.config.store.currency).toBe('TWD');
    expect(result.runtime.modules).toHaveLength(24);
    expect(result.runtime.actorForRole('staff').permissions).toContain('erp:write');
    await result.runtime.migrate();
    await expect(result.runtime.migrate()).resolves.toEqual([]);
    const tables = await result.runtime.database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'catalog_products'",
    );
    expect(tables.rows).toEqual([{ tablename: 'catalog_products' }]);
  });
});
