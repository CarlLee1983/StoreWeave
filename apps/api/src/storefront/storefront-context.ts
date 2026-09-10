import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import type { PageResolveContext, StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import { actorOf, anonymousActor, type AuthenticatedRequest } from '../http/auth';
import { sessionTokenOf } from '../http/session-cookies';
import { cartNoticeOf, clearCartNoticeCookie, existingGuestToken, guestTokenFor } from '../http/cart-cookie';
import type { Runtime } from '../tokens';

/**
 * 前台每個請求共用的組裝。generated controller 與尚未遷移的 storefront handler
 * 都從這裡取得同一份 Theme 環境與錯誤頁，兩邊不會各自長出一套語意。
 */
export interface StorefrontContextDeps {
  readonly runtime: Runtime;
  readonly theme: StorefrontTheme;
  /** 匿名請求使用的角色；base 與 commerce release 各自不同。 */
  readonly anonymousRole: string | null;
}

/**
 * 一次性提示：讀到就清掉。清除要落在同一個回應上，否則它會在每一頁重複出現。
 */
function takeNotice(deps: StorefrontContextDeps, req?: AuthenticatedRequest, reply?: FastifyReply): string | null {
  const notice = cartNoticeOf(req, deps.runtime.config.http.publicUrl);
  if (!notice) return null;
  if (reply) clearCartNoticeCookie(reply, deps.runtime.config.http.publicUrl);
  return notice;
}

/**
 * 哪幾種品牌內容目前有已發布的文章。導覽列靠它決定要不要出現入口——
 * Theme 不該自己猜哪些頁面存在（ADR 0033）。沒有 content 模組的 release 直接是空陣列。
 */
async function publishedContentKinds(deps: StorefrontContextDeps): Promise<readonly string[]> {
  try {
    const result = await deps.runtime.queries.execute<{ kinds: string[] }>(
      'commerce.content.getPublishedKinds', {},
      { actor: anonymousActor(deps.runtime, deps.anonymousRole), channel: 'rest' },
    );
    return result.kinds;
  } catch (err) {
    // 導覽不值得讓一整頁失敗，但這裡失敗仍是故障：不顯示品牌連結，並在日誌說明原因。
    deps.runtime.logger.warn({ error: (err as Error).message }, 'brand navigation lookup failed');
    return [];
  }
}

export async function buildThemeContext(
  deps: StorefrontContextDeps, req?: AuthenticatedRequest, reply?: FastifyReply,
): Promise<ThemeContext> {
  const store = deps.runtime.config.store;
  const sessionToken = sessionTokenOf(req, deps.runtime.config.http.publicUrl);
  const actor = req?.actor;
  return {
    storeName: store.name,
    storeId: store.id,
    // 貨幣是商務設定；base-only 的 store 區塊沒有它。
    ...('currency' in store ? { currency: store.currency as string } : {}),
    locale: store.locale,
    timeZone: store.timezone,
    publicUrl: deps.runtime.config.http.publicUrl,
    supportEmail: store.supportEmail,
    options: deps.runtime.config.theme.options,
    customerName: actor?.type === 'customer' ? actor.displayName ?? null : null,
    // 有 session 就發 token：守衛對任何 cookie 身分都會驗 CSRF，只發給顧客的話，
    // 後台身分逛前台送出表單會拿到裸的 403，而不是那句「請先登入」。
    csrfToken: sessionToken && actor && actor.type !== 'service' ? csrfTokenFor(sessionToken) : null,
    publishedContentKinds: await publishedContentKinds(deps) as ThemeContext['publishedContentKinds'],
    notice: takeNotice(deps, req, reply),
  };
}

/** 交給模組 resolve 的執行環境。身分永遠存在，未登入時是匿名 actor。 */
export function buildResolveContext(
  deps: StorefrontContextDeps, req: AuthenticatedRequest, reply: FastifyReply,
): PageResolveContext {
  const actor = req.actor ? actorOf(req) : anonymousActor(deps.runtime, deps.anonymousRole);
  return {
    queries: {
      execute: (name, input, options) =>
        deps.runtime.queries.execute(name, input, { ...options, channel: 'rest' }),
    },
    commands: {
      execute: (name, input, options) =>
        deps.runtime.commands.execute(name, input, { ...options, channel: 'rest' }),
    },
    actor,
    locale: deps.runtime.config.store.locale,
    // 雜湊而不是原始位址：頁面要的是「分得出是不是同一個人」，不是知道他在哪。
    clientKey: createHash('sha256').update(req.ip ?? 'unknown').digest('hex').slice(0, 32),
    cookies: {
      guestCartToken: () => existingGuestToken(req, deps.runtime.config.http.publicUrl) ?? null,
      // 簽發會寫進這個回應，所以只在真的要建立購物車時呼叫，不是每頁都叫一次。
      ensureGuestCart: () => guestTokenFor(req, reply, deps.runtime.config.http.publicUrl)!,
    },
    providers: { get: (kind, id) => deps.runtime.providers.get(kind as never, id) as never },
  };
}

/**
 * 錯誤頁。5xx 記錄原始訊息但只對外說「發生未預期的錯誤」——內部細節不進 HTML。
 */
export async function renderStorefrontError(
  deps: StorefrontContextDeps, reply: FastifyReply, error: unknown, req?: AuthenticatedRequest,
): Promise<void> {
  const status = error instanceof PlatformError ? error.httpStatus : 500;
  const message = error instanceof PlatformError && status < 500 ? error.message : '發生未預期的錯誤';
  if (status >= 500) deps.runtime.logger.error({ error: (error as Error).message }, 'storefront error');

  const render = deps.theme.renderers['platform.error'];
  if (!render) throw error;
  const body = render(await buildThemeContext(deps, req, reply), { status, message });
  void reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
}
