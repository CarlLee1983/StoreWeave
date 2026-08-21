import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
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
