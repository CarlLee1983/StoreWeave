import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import type { Runtime } from '@storeweave/kernel';
import { defaultTheme } from '@storeweave/theme-default';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { StorefrontController } from '../../apps/api/src/storefront/storefront.controller';

const staticAdapter: ReleaseHttpAdapter = {
  releaseId: 'test', anonymousRole: 'storefront', controllers: () => [], startSession: async () => null,
};
const storefrontAdapter: ReleaseHttpAdapter = { ...staticAdapter, controllers: () => [StorefrontController] };

describe('Theme-owned storefront assets', () => {
  let app: NestFastifyApplication;
  let runtime: Runtime;

  beforeAll(async () => {
    // No route in this test touches the commerce runtime. Keeping the stub
    // deliberately small isolates the asset-delivery boundary from the domain.
    runtime = {
      config: {
        http: { trustProxy: false, bodyLimitBytes: 1_048_576, publicUrl: 'http://localhost:3000', cors: { allowedOrigins: [], credentials: false } },
        shutdown: { timeoutMs: 1_000 },
        store: { id: 'test-store', name: 'Test Store', currency: 'TWD', locale: 'zh-TW' }, theme: { options: {} },
        // Production registers the admin SPA and theme assets together. This
        // keeps the static-plugin decorator collision covered without needing
        // an unrelated built admin artifact in the test fixture.
        admin: { enabled: true, basePath: '/admin' },
        mcp: { enabled: false },
      },
      actorForRole: (role: string, id?: string) => ({ id: id ?? role, type: 'service', permissions: [] }),
      providers: { get: vi.fn() },
      commands: { execute: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
    } as unknown as Runtime;
    app = await createReleaseServer({
      runtime,
      httpAdapter: staticAdapter,
      theme: defaultTheme,
      release: {
        version: 'test',
        configPath: '<test>',
        adminDir: resolve(process.cwd(), 'apps/admin/dist'),
        themeAssetsDir: resolve(process.cwd(), 'packages/themes/default/assets'),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves only packaged theme artwork from a same-origin path', async () => {
    const asset = await app.inject({ method: 'GET', url: '/storefront-assets/woven-day-hero.png' });
    const productAsset = await app.inject({ method: 'GET', url: '/storefront-assets/woven-day-products-pottery.png' });
    const missing = await app.inject({ method: 'GET', url: '/storefront-assets/not-a-theme-asset.png' });
    const traversal = await app.inject({ method: 'GET', url: '/storefront-assets/%2e%2e/package.json' });
    const nulPath = await app.inject({ method: 'GET', url: '/storefront-assets/%00' });

    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('image/png');
    expect(asset.headers['cache-control']).toBe('public, max-age=0');
    expect(asset.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(productAsset.statusCode).toBe(200);
    expect(productAsset.headers['content-type']).toContain('image/png');
    expect(missing.statusCode).toBe(404);
    expect(traversal.statusCode).toBe(404);
    expect(nulPath.statusCode).toBe(404);
    const catalog = app.getHttpAdapter().getInstance() as { storeweaveHttpCatalog?: readonly { method: string; path: string; kind: string }[] };
    expect(catalog.storeweaveHttpCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/storefront-assets/*', kind: 'static-theme-assets', automaticMethods: ['HEAD'] }),
    ]));
  });


  it('adds CORS to the real optional static routes only when configured', async () => {
    const cors = runtime.config.http.cors;
    const savedOrigins = [...cors.allowedOrigins];
    const savedCredentials = cors.credentials;
    let corsApp: NestFastifyApplication | undefined;
    try {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, 'https://console.example');
      cors.credentials = true;
      corsApp = await createReleaseServer({
        runtime, httpAdapter: staticAdapter, theme: defaultTheme,
        release: { version: 'test', configPath: '<test>', adminDir: resolve(process.cwd(), 'apps/admin/dist'),
          themeAssetsDir: resolve(process.cwd(), 'packages/themes/default/assets') },
      });
      const asset = await corsApp.inject({ url: '/storefront-assets/woven-day-hero.png', headers: { origin: 'https://console.example' } });
      const preflight = await corsApp.inject({ method: 'OPTIONS', url: '/storefront-assets/woven-day-hero.png', headers: {
        origin: 'https://console.example', 'access-control-request-method': 'GET',
      } });
      expect(asset).toMatchObject({ statusCode: 200, headers: {
        'access-control-allow-origin': 'https://console.example', 'access-control-allow-credentials': 'true',
      } });
      expect(preflight).toMatchObject({ statusCode: 204, headers: {
        'access-control-allow-origin': 'https://console.example', 'access-control-allow-credentials': 'true',
      } });
    } finally {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, ...savedOrigins);
      cors.credentials = savedCredentials;
      await corsApp?.close();
    }
  });
});
