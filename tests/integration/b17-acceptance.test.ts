import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Runtime } from '@storeweave/kernel';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { httpAdapter as commerceHttpAdapter } from '../../apps/api/src/releases/commerce';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import type { BaseConfig, CommerceConfig } from '@storeweave/config';
import type { ReleaseDefinition } from '../../packages/platform/bundle/src/release';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';

process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');

const runtimes: Runtime[] = [];
const apps: { close(): Promise<void> }[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startRelease(
  release: ReleaseDefinition<BaseConfig> | ReleaseDefinition<CommerceConfig>,
  httpAdapter: ReleaseHttpAdapter,
  databaseUrl: string,
  themeId: string,
  options: Record<string, unknown>,
  storageRoot?: string,
) {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-b17-'));
  directories.push(directory);
  const configPath = join(directory, `${themeId}.yaml`);
  const resolvedStorageRoot = storageRoot ?? join(directory, 'storage');
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    store: { id: 'b17-site', name: 'B17 site', locale: 'en' },
    database: { url: databaseUrl },
    storage: { localRoot: resolvedStorageRoot },
    theme: { id: themeId, options },
    logging: { level: 'error' },
    extensions: [],
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  // Base and Commerce intentionally have contravariant config types. The
  // selected release has already been fixed by the profile table above; the
  // cast only lets this shared test harness call the generic bootstrap helper.
  const result = await bootstrapRelease(release as unknown as ReleaseDefinition<BaseConfig>, {
    configPath, loggerName: `b17-${themeId}`,
  });
  runtimes.push(result.runtime);
  await result.runtime.migrate();
  const app = await createReleaseServer({
    runtime: result.runtime, theme: result.theme, httpAdapter,
    release: { version: release.version, configPath: result.loaded.sourcePath },
  });
  apps.push(app);
  return { ...result, app, storageRoot: resolvedStorageRoot };
}

async function stop(result: { app: { close(): Promise<void> }; runtime: Runtime }) {
  await result.app.close();
  await result.runtime.close();
  const appIndex = apps.indexOf(result.app);
  if (appIndex >= 0) apps.splice(appIndex, 1);
  const runtimeIndex = runtimes.indexOf(result.runtime);
  if (runtimeIndex >= 0) runtimes.splice(runtimeIndex, 1);
}

async function digestObject(runtime: Runtime, id: string): Promise<string> {
  const opened = await runtime.storage.forNamespace('platform-media').open(id);
  const digest = createHash('sha256');
  for await (const chunk of opened.content.stream) digest.update(Buffer.from(chunk));
  return digest.digest('hex');
}

async function createPublishedArticle(runtime: Runtime, slug: string, kind: 'story' | 'journal' | 'news' = 'news') {
  const article = await runtime.commands.execute<{ id: string }>('commerce.content.createArticle', {
    kind, slug, title: `B17 ${slug}`, summary: 'B17 acceptance article',
    body: [{ heading: null, text: 'Content survives a theme switch.' }],
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  await runtime.commands.execute('commerce.content.publishArticle', { id: article.id }, {
    actor: ADMIN_ACTOR, idempotencyKey: randomUUID(),
  });
  return article.id;
}

describe('B17 overall acceptance', () => {
  it('assembles shopping, image-site and Blog profiles from one versioned release graph', async () => {
    for (const profile of [
      { id: 'image-site', slug: 'image-site-story', kind: 'story' as const, release: baseRelease, adapter: httpAdapter, themeId: 'base' as const },
      { id: 'blog', slug: 'blog-entry', kind: 'journal' as const, release: baseRelease, adapter: httpAdapter, themeId: 'base' as const },
      { id: 'shopping', slug: 'shopping-news', kind: 'news' as const, release: commerceRelease, adapter: commerceHttpAdapter, themeId: 'default' as const },
    ]) {
      const databaseUrl = await createTestDatabase();
      const result = await startRelease(profile.release, profile.adapter, databaseUrl, profile.themeId, {
        base: { accentColor: '#2F5D62' }, default: { accentColor: '#8C3E28' }, editorial: { accentColor: '#445566' },
      });
      const articleId = await createPublishedArticle(result.runtime, profile.slug, profile.kind);
      const page = await result.app.inject({ url: profile.kind === 'story' ? '/story' : `/${profile.kind}/${profile.slug}` });
      expect(page.statusCode, profile.id).toBe(200);
      expect(page.body, profile.id).toContain(`B17 ${profile.slug}`);
      expect(articleId, profile.id).toMatch(/^[0-9a-f-]{36}$/);
      if (profile.id === 'shopping') {
        expect(result.runtime.modules.map(module => module.name)).toContain('catalog');
        expect((await result.app.inject({ url: '/' })).statusCode).toBe(200);
      } else {
        expect(result.runtime.modules.map(module => module.name).some(name =>
          ['catalog', 'inventory', 'cart', 'customer', 'order', 'promotion', 'coupon', 'loyalty', 'shipping', 'invoice', 'refund', 'rma'].includes(name),
        ), profile.id).toBe(false);
        const commerceTable = await result.runtime.database.pool.query<{ table: string | null }>(
          "SELECT to_regclass('public.catalog_products') AS table",
        );
        expect(commerceTable.rows[0]?.table, profile.id).toBeNull();
      }
      await stop(result);
    }
  }, 180_000);

  it('preserves content, media bytes, URLs, navigation and site settings across Base theme switches', async () => {
    const databaseUrl = await createTestDatabase();
    const first = await startRelease(baseRelease, httpAdapter, databaseUrl, 'base', {
      base: { accentColor: '#112233' }, editorial: { accentColor: '#445566' },
    });
    const articleId = await createPublishedArticle(first.runtime, 'theme-switch-proof');
    await first.runtime.commands.execute('platform.site.updateSettings', {
      tagline: 'Stable site data', footerNote: 'B17 footer',
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await first.runtime.commands.execute('platform.site.replaceNavigation', {
      menu: 'primary',
      items: [{ groupLabel: null, label: '持久連結', href: '/news/theme-switch-proof', position: 0, requiresContentKind: null }],
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const media = await first.runtime.media.upload({
      stream: Readable.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')),
      originalName: 'b17-proof.png', contentType: 'image/png', ownerActorId: 'user:b17',
    });
    await first.runtime.media.process({ assetId: media.id, generation: media.generation }, { signal: new AbortController().signal });
    await first.runtime.commands.execute('commerce.content.setArticleMedia', { id: articleId, mediaAssetId: media.id }, {
      actor: ADMIN_ACTOR, idempotencyKey: randomUUID(),
    });
    const before = {
      article: (await first.runtime.database.pool.query('SELECT id, kind, slug, title, status, media_asset_id FROM content_articles WHERE id = $1', [articleId])).rows,
      media: (await first.runtime.database.pool.query('SELECT id, status, original_object_id, preview_object_id FROM platform_media_assets WHERE id = $1', [media.id])).rows,
      refs: (await first.runtime.database.pool.query('SELECT media_asset_id, owner_type, owner_id FROM platform_media_references WHERE owner_id = $1', [articleId])).rows,
      settings: (await first.runtime.database.pool.query('SELECT tagline, footer_note FROM platform_site_settings')).rows,
      navigation: (await first.runtime.database.pool.query('SELECT menu, label, href, position FROM platform_site_navigation_items ORDER BY menu, position')).rows,
      mediaDigest: await digestObject(first.runtime, media.originalObjectId),
    };
    const firstPage = await first.app.inject({ url: '/news/theme-switch-proof' });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body).toContain('#112233');
    expect(firstPage.body).toContain('持久連結');
    await stop(first);

    const second = await startRelease(baseRelease, httpAdapter, databaseUrl, 'editorial', {
      base: { accentColor: '#112233' }, editorial: { accentColor: '#445566' },
    }, first.storageRoot);
    const secondPage = await second.app.inject({ url: '/news/theme-switch-proof' });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.body).toContain('#445566');
    expect(secondPage.body).toContain('Stable site data');
    expect(secondPage.body).toContain('持久連結');
    expect(second.runtime.config.theme.options).toEqual({
      base: { accentColor: '#112233' }, editorial: { accentColor: '#445566' },
    });
    const after = {
      article: (await second.runtime.database.pool.query('SELECT id, kind, slug, title, status, media_asset_id FROM content_articles WHERE id = $1', [articleId])).rows,
      media: (await second.runtime.database.pool.query('SELECT id, status, original_object_id, preview_object_id FROM platform_media_assets WHERE id = $1', [media.id])).rows,
      refs: (await second.runtime.database.pool.query('SELECT media_asset_id, owner_type, owner_id FROM platform_media_references WHERE owner_id = $1', [articleId])).rows,
      settings: (await second.runtime.database.pool.query('SELECT tagline, footer_note FROM platform_site_settings')).rows,
      navigation: (await second.runtime.database.pool.query('SELECT menu, label, href, position FROM platform_site_navigation_items ORDER BY menu, position')).rows,
      mediaDigest: await digestObject(second.runtime, media.originalObjectId),
    };
    expect(after).toEqual(before);
  }, 180_000);
});
