import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { withCleanupDeadline, type Runtime, type StorefrontTheme } from '@storeweave/kernel';
import { AppModule } from './app.module';
import { resolveThemeAssetsDir } from './theme-assets';
import type { ReleaseInfo } from './tokens';
import type { ReleaseHttpAdapter } from './release-adapter';
import { httpError, httpErrorSchema } from './http/envelope';
import { catalogHttpRoutes, HTTP_ROUTE_CATALOG, validateMountedHttpRoutes, type HttpRouteConfig, type MountedHttpRoute, type ReleaseOwnedHttpRoute, type StaticHttpRoute } from './http/contract';
import { corsPreflightRoute, releaseCorsOptions } from './http/cors';

export interface ReleaseServerOptions {
  httpAdapter: ReleaseHttpAdapter;
  runtime: Runtime;
  theme?: StorefrontTheme;
  release: ReleaseInfo;
}

/** 建立 HTTP 應用程式（不 listen），讓整合測試可以直接注入 runtime 使用。 */
export async function createReleaseServer(options: ReleaseServerOptions): Promise<NestFastifyApplication> {
  const { runtime, theme, release } = options;
  const cors = releaseCorsOptions(runtime.config.http.cors);

  const adapter = new FastifyAdapter({
    trustProxy: runtime.config.http.trustProxy,
    bodyLimit: runtime.config.http.bodyLimitBytes,
    genReqId: () => crypto.randomUUID(),
  });
  const mountedRoutes: MountedHttpRoute[] = [];
  adapter.getInstance().addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) mountedRoutes.push({ method: method.toUpperCase(), path: route.url });
  });
  // application/x-www-form-urlencoded（Storefront 表單）由 Nest 的 FastifyAdapter 自行註冊解析器。

  let app: NestFastifyApplication | undefined;
  let selectedControllers: ReturnType<ReleaseHttpAdapter['controllers']>;
  const staticRoutes: StaticHttpRoute[] = [];
  const registerStaticGet = (route: StaticHttpRoute, handler: (request: FastifyRequest, reply: FastifyReply) => unknown) => {
    staticRoutes.push(route);
    adapter.getInstance().get(route.path, handler as never);
  };
  try {
    selectedControllers = options.httpAdapter.controllers(runtime.config);
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forRuntime(runtime, theme, release, options.httpAdapter, selectedControllers),
      adapter,
      // Providers verify the exact bytes they received. Keep a bounded raw copy in
      // addition to Fastify's parsed form body for the generic callback controller.
      { logger: false, bufferLogs: true, rawBody: true, abortOnError: false },
    );
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, () => adapter.close()); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'HTTP creation and cleanup failed'); }
    throw error;
  }

  try {
    if (cors) app.enableCors(cors);
    // Session / CSRF cookie 只做解析與序列化，不簽章——token 本身已經是高熵隨機值。
    await app.register(fastifyCookie);
    // Do not use saveRequestFiles: uploads must remain streamed and the storage
    // manager owns every temporary file. The plugin limits reject extra parts
    // before an unbounded multipart body reaches a controller. Some narrowly
    // scoped HTTP tests use a legacy partial runtime configuration and do not
    // install the storage release, so only register this parser when storage is
    // configured.
    const storage = (runtime.config as typeof runtime.config & {
      storage?: { maxUploadBytes: number };
    }).storage;
    if (storage) {
      await app.register(fastifyMultipart, {
        limits: { files: 1, fields: 0, parts: 1, fileSize: storage.maxUploadBytes },
        throwFileSizeLimit: true,
      });
    }

    // 只節流登入端點。沒有它，密碼爆破不受限制，而且每次嘗試都逼伺服器跑一次
    // 記憶體困難的 scrypt —— 未授權請求會變成 CPU 與記憶體的放大攻擊面。
    // 計數存在行程記憶體裡：單站部署只有一個 API 行程，這與 Redis 選配的前提一致（ADR 0003）。
    await app.register(fastifyRateLimit, { global: false });
    // 兩層節流。第一層綁帳號：擋針對特定帳號的爆破。
    const perAccountLimiter = app.getHttpAdapter().getInstance().createRateLimit({
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (request) => {
        const body = request.body as { email?: unknown } | undefined;
        const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
        return `auth:${request.ip}|${email}`;
      },
    });
    // 第二層只綁 IP：每次嘗試都逼伺服器跑一次記憶體困難的 scrypt，
    // 只綁帳號的話，攻擊者每次換一個隨機 email 就換一個桶，放大攻擊面等於沒關。
    const perIpLimiter = app.getHttpAdapter().getInstance().createRateLimit({
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (request) => `auth-ip:${request.ip}`,
    });

    const cartLimiter = app.getHttpAdapter().getInstance().createRateLimit({
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (request) => `cart:${request.ip}`,
    });
    const couponLimiter = app.getHttpAdapter().getInstance().createRateLimit({
      max: 20,
      timeWindow: '1 minute',
      keyGenerator: (request) => `coupon:${request.ip}`,
    });
    const callbackLimiter = app.getHttpAdapter().getInstance().createRateLimit({
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: (request) => `callback:${request.ip}`,
    });

    app.getHttpAdapter().getInstance().addHook('preHandler', async (request, reply) => {
      if (request.method !== 'POST') return;
      // Fastify selects this config after decoding and matching the route, so an
      // encoded path such as /api/v1/auth/%6cogin uses the login contract too.
      const contract = (request.routeOptions.config as HttpRouteConfig).storeweaveContract;
      const bucket = contract && 'rateLimit' in contract ? contract.rateLimit : undefined;
      const limiters = bucket === 'auth' ? [perIpLimiter, perAccountLimiter]
        : bucket === 'coupon' ? [couponLimiter]
          : bucket === 'cart' ? [cartLimiter]
            : bucket === 'callback' ? [callbackLimiter] : [];
      if (limiters.length === 0) return;

      for (const limiter of limiters) {
        const result = await limiter(request);
        // isAllowed 只有 allowList 命中時才是 true；一般路徑一律回 false，要看的是 isExceeded。
        if (!result.isAllowed && result.isExceeded) {
          reply.header('retry-after', String(result.ttlInSeconds));
          await reply.status(429).send(httpError({ code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' }));
          return;
        }
      }
    });

    // `@fastify/static` adds `reply.sendFile` when requested. Both the admin SPA
    // and theme assets can be present in one release, but Fastify only permits a
    // decorator to be registered once.
    let replyHasSendFile = false;

    if (runtime.config.admin.enabled && release.adminDir && existsSync(release.adminDir)) {
      const adminDir = resolve(release.adminDir);
      const prefix = runtime.config.admin.basePath.endsWith('/')
        ? runtime.config.admin.basePath
        : `${runtime.config.admin.basePath}/`;
      // serve:false 只借用 reply.sendFile：靜態檔在請求當下解析，
      // 不在啟動時把目錄快照成路由表（否則重新 build 後的 hash 檔名會全數 404）。
      app.useStaticAssets({ root: adminDir, prefix, serve: false, decorateReply: true });
      replyHasSendFile = true;

      const indexPath = join(adminDir, 'index.html');
      if (existsSync(indexPath)) {
        const sendIndex = (_request: FastifyRequest, reply: FastifyReply) =>
          reply
            .status(200)
            .header('content-type', 'text/html; charset=utf-8')
            .header('cache-control', 'no-cache')
            .send(readFileSync(indexPath, 'utf8'));
        registerStaticGet({
          method: 'GET', path: runtime.config.admin.basePath, kind: 'static-admin-index', auth: 'public', request: 'none',
          input: { type: 'object', properties: {}, additionalProperties: false },
          success: { status: 200, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: 'index-html' },
        }, sendIndex);
        // Admin 是編譯後的 SPA：有實體檔案就送檔，其餘深層路徑（例如 /admin/orders）回 index.html。
        registerStaticGet({
          method: 'GET', path: `${prefix}*`, kind: 'static-admin-spa', auth: 'public', request: 'none',
          input: { type: 'object', properties: {}, additionalProperties: false },
          success: { status: 200, body: 'static-file' },
          fallback: { status: 200, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: 'index-html' },
        }, (request, reply) => {
          const relative = (request.params as Record<string, string>)['*'] ?? '';
          const resolved = resolve(adminDir, relative);
          const withinAdminDir = resolved === adminDir || resolved.startsWith(adminDir + sep);
          if (relative && withinAdminDir && statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
            return (reply as FastifyReply & { sendFile(path: string): FastifyReply }).sendFile(relative);
          }
          return sendIndex(request, reply);
        });
      }
    }

    // Resolve again at the delivery boundary. A long-lived development watcher
    // can retain an older release descriptor while the source artwork changes.
    const themeAssetsDir = theme && resolveThemeAssetsDir({ configuredDir: release.themeAssetsDir });
    if (theme && themeAssetsDir && existsSync(themeAssetsDir)) {
      const prefix = '/storefront-assets/';
      // Theme artwork has a deliberately narrow, separate public path. It is not
      // a general filesystem endpoint and it must not be confused with merchant
      // product media, whose delivery rules belong to a future catalog contract.
      app.useStaticAssets({ root: themeAssetsDir, prefix, serve: false, decorateReply: !replyHasSendFile });
      replyHasSendFile = true;
      registerStaticGet({
        method: 'GET', path: `${prefix}*`, kind: 'static-theme-assets', auth: 'public', request: 'none',
        input: { type: 'object', properties: {}, additionalProperties: false },
        success: { status: 200, body: 'static-file' },
        notFound: { status: 404, contentType: 'application/json', output: zodToJsonSchema(httpErrorSchema as never, { target: 'jsonSchema7' }) },
      }, (request, reply) => {
        const relative = (request.params as Record<string, unknown>)['*'];
        if (typeof relative !== 'string' || !relative || relative.includes('\0')) {
          return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
        }
        const resolved = resolve(themeAssetsDir, relative);
        const withinThemeAssetsDir = resolved === themeAssetsDir || resolved.startsWith(themeAssetsDir + sep);
        if (relative && withinThemeAssetsDir && statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
          const assetReply = reply as FastifyReply & { sendFile(path: string, root?: string): FastifyReply };
          return assetReply.sendFile(relative, themeAssetsDir);
        }
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      });
    }


    await app.init();
    const releaseRoutes: ReleaseOwnedHttpRoute[] = cors ? [...staticRoutes, corsPreflightRoute(cors)] : staticRoutes;
    const catalog = validateMountedHttpRoutes(catalogHttpRoutes(runtime, selectedControllers, releaseRoutes), mountedRoutes);
    adapter.getInstance().decorate(HTTP_ROUTE_CATALOG, catalog);
    return app;
  } catch (error) {
    try { await withCleanupDeadline(runtime.config.shutdown.timeoutMs, () => app?.close()); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'HTTP initialization and cleanup failed'); }
    throw error;
  }
}
