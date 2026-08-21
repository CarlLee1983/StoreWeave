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
  const loginLimiter = app.getHttpAdapter().getInstance().createRateLimit({
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const body = request.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
      // 同時綁 IP 與帳號：換 IP 換不掉對單一帳號的節流，反之亦然。
      return `${request.ip}|${email}`;
    },
  });
  app.getHttpAdapter().getInstance().addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || !request.url.startsWith('/api/v1/auth/login')) return;
    const result = await loginLimiter(request);
    // isAllowed 只有 allowList 命中時才是 true；一般路徑一律回 false，要看的是 isExceeded。
    if (!result.isAllowed && result.isExceeded) {
      reply.header('retry-after', String(result.ttlInSeconds));
      await reply.status(429).send({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many login attempts, please try again later' },
      });
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
