import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyReply } from 'fastify';
import type { Runtime, StorefrontTheme } from '@storeweave/kernel';
import { AppModule } from './app.module';
import type { ReleaseInfo } from './tokens';

export interface ServerOptions {
  runtime: Runtime;
  theme: StorefrontTheme;
  release: ReleaseInfo;
}

/** 建立 HTTP 應用程式（不 listen），讓整合測試可以直接注入 runtime 使用。 */
export async function createServer(options: ServerOptions): Promise<NestFastifyApplication> {
  const { runtime, theme, release } = options;

  const adapter = new FastifyAdapter({
    trustProxy: runtime.config.http.trustProxy,
    bodyLimit: runtime.config.http.bodyLimitBytes,
    genReqId: () => crypto.randomUUID(),
  });
  // application/x-www-form-urlencoded（Storefront 表單）由 Nest 的 FastifyAdapter 自行註冊解析器。

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRuntime(runtime, theme, release),
    adapter,
    { logger: false, bufferLogs: true },
  );

  // Session / CSRF cookie 只做解析與序列化，不簽章——token 本身已經是高熵隨機值。
  await app.register(fastifyCookie);

  // 只節流登入端點。沒有它，密碼爆破不受限制，而且每次嘗試都逼伺服器跑一次
  // 記憶體困難的 scrypt —— 未授權請求會變成 CPU 與記憶體的放大攻擊面。
  // 計數存在行程記憶體裡：單站部署只有一個 API 行程，這與 Redis 選配的前提一致（ADR 0003）。
  await app.register(fastifyRateLimit, { global: false });
  // 註冊也要節流：它同樣跑一次 scrypt，而且沒有節流就是一條免費的帳號枚舉與洗帳號管道。
  // 前台的表單路由與 API 端點一樣要節流：它們跑的是同一支 scrypt，
  // 只擋 /api/v1/auth/login 等於把大門鎖上、後門開著。
  const THROTTLED_ROUTES = new Set([
    '/api/v1/auth/login',
    '/api/v1/customers/register',
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
  ]);

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

  // 套用折扣碼同樣要節流，理由不同：那是一條可以暴力猜碼的管道，
  // 而共用碼的損失上限就是整檔活動的預算。綁 IP 就夠——碼不綁帳號。
  const COUPON_ROUTES = new Set(['/api/v1/cart/coupon', '/cart/coupon']);
  const couponLimiter = app.getHttpAdapter().getInstance().createRateLimit({
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request) => `coupon:${request.ip}`,
  });

  app.getHttpAdapter().getInstance().addHook('preHandler', async (request, reply) => {
    // 比對正規化後的路由，不是原始 URL：request.url 保留百分比編碼，
    // 而 Fastify 是解碼後才比對路由，因此 /api/v1/auth/%6cogin 會打到 login
    // 卻繞過任何用 startsWith(request.url) 寫成的條件。
    const route = request.routeOptions?.url ?? '';
    if (request.method !== 'POST') return;

    const limiters = THROTTLED_ROUTES.has(route)
      ? [perIpLimiter, perAccountLimiter]
      : COUPON_ROUTES.has(route) ? [couponLimiter] : [];
    if (limiters.length === 0) return;

    for (const limiter of limiters) {
      const result = await limiter(request);
      // isAllowed 只有 allowList 命中時才是 true；一般路徑一律回 false，要看的是 isExceeded。
      if (!result.isAllowed && result.isExceeded) {
        reply.header('retry-after', String(result.ttlInSeconds));
        await reply.status(429).send({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' },
        });
        return;
      }
    }
  });

  if (runtime.config.admin.enabled && release.adminDir && existsSync(release.adminDir)) {
    const prefix = runtime.config.admin.basePath.endsWith('/')
      ? runtime.config.admin.basePath
      : `${runtime.config.admin.basePath}/`;
    app.useStaticAssets({ root: release.adminDir, prefix, decorateReply: false, wildcard: false });

    // Admin 是編譯後的 SPA：深層路徑（例如 /admin/orders）直接回 index.html。
    // 直接註冊在 Fastify 上，不動 Nest 的路由表與 notFound handler。
    const indexPath = join(release.adminDir, 'index.html');
    if (existsSync(indexPath)) {
      const indexHtml = readFileSync(indexPath, 'utf8');
      const sendIndex = (_request: unknown, reply: FastifyReply) =>
        reply.status(200).header('content-type', 'text/html; charset=utf-8').send(indexHtml);
      const fastify = adapter.getInstance();
      fastify.get(runtime.config.admin.basePath, sendIndex);
      fastify.get(`${prefix}*`, sendIndex);
    }
  }

  await app.init();
  return app;
}
