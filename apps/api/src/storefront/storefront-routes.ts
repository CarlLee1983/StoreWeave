import 'reflect-metadata';
import { Controller, Get, Post, Req, Res, type Type } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { IssuedSession } from '@storeweave/identity';
import { safeRedirectPath } from '@storeweave/kernel';
import type { PageOutcome, PageResolveContext, StorefrontPage, StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import { PlatformError } from '@storeweave/contracts';
import { ZodError } from 'zod';
import { HttpContract, type HttpRouteContract } from '../http/contract';
import { Public } from '../http/auth';
import type { AuthenticatedRequest } from '../http/auth';

export interface StorefrontRouteDeps {
  readonly theme: StorefrontTheme;
  /** 每個請求的 Theme 環境（門市資訊、CSRF、一次性提示）。 */
  readonly buildContext: (req: AuthenticatedRequest, reply: FastifyReply) => Promise<ThemeContext>;
  /** 交給模組 resolve 的執行環境；actor 由請求決定。 */
  readonly resolveContext: (req: AuthenticatedRequest, reply: FastifyReply) => PageResolveContext;
  /**
   * 頁面交出來的 session outcome 由誰執行。簽發那一端是 release 的事（要不要合併訪客
   * 購物車由組裝決定），所以它是注入進來的，不是這裡自己 import 的（ADR 0047、工單 92）。
   */
  readonly sessionEffects: {
    readonly start: (req: AuthenticatedRequest, reply: FastifyReply, session: IssuedSession) => Promise<unknown>;
    readonly clear: (req: AuthenticatedRequest, reply: FastifyReply) => Promise<unknown>;
  };
  /** 錯誤頁。沒有提供時直接把 PlatformError 往上拋給例外過濾器。 */
  readonly renderError?: (req: AuthenticatedRequest, reply: FastifyReply, error: unknown) => Promise<void>;
}

/** Nest 的 route path 不帶前導斜線；根路徑交給它自己正規化成 '/'。 */
const nestPath = (path: string): string => path.replace(/^\/+/, '');

/** page id 不是合法的識別字，但方法名只要唯一且穩定就夠了。 */
const handlerName = (id: string): string => `page_${id.replace(/[^A-Za-z0-9]/g, '_')}`;

const requiresIdentity = (page: StorefrontPage<any, any>): boolean => page.audience !== 'public';

const identityMatches = (page: StorefrontPage<any, any>, req: AuthenticatedRequest): boolean => {
  const type = req.actor?.type;
  if (page.audience === 'customer') return type === 'customer';
  if (page.audience === 'operator') return type === 'user';
  return true;
};

/**
 * 從模組宣告的頁面生成一個 Nest controller。路由是資料驅動的，但守衛鏈、CSRF 規則與
 * 啟動時的契約檢查全部沿用 decorator 那一套——資料驅動不該換來一次安全性退步（ADR 0045）。
 */
export function createStorefrontController(
  pages: readonly StorefrontPage<any, any>[],
  deps: StorefrontRouteDeps,
): Type<object> {
  class GeneratedStorefrontController {}
  const prototype = GeneratedStorefrontController.prototype as Record<string, unknown>;

  for (const page of pages) {
    const name = handlerName(page.id);

    const handler = async function (req: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
      const source = req as AuthenticatedRequest & {
        params?: Record<string, string | undefined>; query?: object; body?: object;
      };
      try {
        if (requiresIdentity(page) && !identityMatches(page, req)) {
          // 匿名身分一律是 service type（`anonymousActor`／`actorForRole`）。已經是真身分卻
          // 不符這一頁要的，不是「請先登入」——把他送去登入頁只會和登入頁的「已登入就轉回來」
          // 互踢成無限轉址（工單 94 的 review）。
          if (req.actor && req.actor.type !== 'service') {
            throw PlatformError.forbidden('這個頁面不屬於目前登入的身分');
          }
          const next = page.loginNext ? page.loginNext(source.params ?? {}) : page.path;
          void reply.status(303).header('location', `/login?next=${encodeURIComponent(next)}`).send();
          return;
        }

        const raw = { ...(source.params ?? {}), ...((page.method === 'get' ? source.query : source.body) ?? {}) };
        // zod 的錯誤是輸入錯誤，不是伺服器故障：轉成 PlatformError 才會回 400 而不是 500。
        const parsed = page.input.safeParse(raw);
        if (!parsed.success) {
          throw PlatformError.validation(parsed.error.issues[0]?.message ?? 'Invalid input', parsed.error.issues);
        }
        const input = parsed.data;
        const outcome = (await page.resolve(deps.resolveContext(req, reply), input)) as PageOutcome<unknown>;

        // 清洗在這裡做一次，頁面因此不必各帶一份（ADR 0047）。固定目的地經過它不會變，
        // 從輸入長出來的目的地則不可能離站。
        if (outcome.kind === 'redirect') {
          void reply.status(303).header('location', safeRedirectPath(outcome.location)).send();
          return;
        }
        // 先做完 cookie 那一側再送轉址：失敗就不送 303，錯誤交給錯誤頁。
        // 注意這不等於「失敗就沒登入」——session 在 resolve 裡已經寫進資料庫，
        // cookie 也可能已經掛在 reply 上。工單 94 決定不回滾（ADR 0047 的「不涵蓋」）。
        if (outcome.kind === 'session-start') {
          await deps.sessionEffects.start(req, reply, outcome.session);
          void reply.status(303).header('location', safeRedirectPath(outcome.location)).send();
          return;
        }
        if (outcome.kind === 'session-clear') {
          await deps.sessionEffects.clear(req, reply);
          void reply.status(303).header('location', safeRedirectPath(outcome.location)).send();
          return;
        }
        if (outcome.kind === 'not-found') throw PlatformError.notFound('Page', page.path);

        const render = deps.theme.renderers[page.id];
        if (!render) {
          // 啟動時的缺頁檢查應該早就攔下這種情況；走到這裡表示註冊表與 Theme 不同步。
          throw PlatformError.validation(`Theme '${deps.theme.id}' 沒有頁面 '${page.id}' 的 renderer`);
        }
        const body = render(await deps.buildContext(req, reply), outcome.view);
        void reply.status(outcome.status ?? 200).header('content-type', 'text/html; charset=utf-8').send(body);
      } catch (error) {
        // resolve 內部也可能拋 zod 錯誤（巢狀 schema），一併當成輸入錯誤。
        const failure = error instanceof ZodError
          ? PlatformError.validation(error.issues[0]?.message ?? 'Invalid input', error.issues)
          : error;
        if (!deps.renderError) throw failure;
        await deps.renderError(req, reply, failure);
      }
    };

    Object.defineProperty(prototype, name, { value: handler, writable: true, enumerable: false, configurable: true });
    Reflect.defineMetadata('design:paramtypes', [Object, Object], prototype, name);

    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    Res()(prototype, name, 1);
    HttpContract(page.contract as HttpRouteContract)(prototype, name, descriptor);
    (page.method === 'get' ? Get : Post)(nestPath(page.path))(prototype, name, descriptor);
  }

  Public()(GeneratedStorefrontController);
  Controller()(GeneratedStorefrontController);
  return GeneratedStorefrontController;
}
