import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Runtime } from '@storeweave/kernel';
import { defaultTheme } from '@storeweave/theme-default';
import { createServer } from '../../apps/api/src/server';

describe('Theme-owned storefront assets', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // No route in this test touches the commerce runtime. Keeping the stub
    // deliberately small isolates the asset-delivery boundary from the domain.
    const runtime = {
      config: {
        http: { trustProxy: false, bodyLimitBytes: 1_048_576, publicUrl: 'http://localhost:3000' },
        // Production registers the admin SPA and theme assets together. This
        // keeps the static-plugin decorator collision covered without needing
        // an unrelated built admin artifact in the test fixture.
        admin: { enabled: true, basePath: '/admin' },
        mcp: { enabled: false },
      },
      providers: { get: vi.fn() },
      commands: { execute: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
    } as unknown as Runtime;
    app = await createServer({
      runtime,
      theme: defaultTheme,
      release: {
        version: 'test',
        configPath: '<test>',
        adminDir: resolve(process.cwd(), 'packages/themes/default/assets'),
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
  });
});
