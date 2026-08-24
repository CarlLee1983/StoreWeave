import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { csrfTokenFor } from '@storeweave/identity';
import { sessionTokenOf } from './session-cookies';
import { RUNTIME, type Runtime } from '../tokens';

export const IS_PUBLIC = 'commerce:public';
/**
 * 標記「不需要 API token」的端點（健康檢查、Storefront）。
 * 它**不**代表強制匿名：帶著有效 session 的請求仍然以本人的身分進來，
 * 前台因此認得出登入者。要一律當訪客的端點請改用 `@Anonymous()`。
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const IS_ANONYMOUS = 'commerce:anonymous';
/**
 * 標記「一律當訪客」的端點：就算帶著有效 session 也不解析。
 * 用在身分還不存在或不該存在的地方——登入本身、探針端點、訪客結帳。
 */
export const Anonymous = () => SetMetadata(IS_ANONYMOUS, true);

export const IS_EXTERNAL_CALLBACK = 'commerce:external-callback';
/**
 * Provider-to-provider callbacks cannot meet browser same-origin or CSRF checks.
 * This is deliberately narrower than `@Public()`: it grants no request actor;
 * the callback controller elevates only after a provider has verified its payload.
 */
export const ExternalCallback = () => SetMetadata(IS_EXTERNAL_CALLBACK, true);

export const STOREFRONT_ROLE = 'storefront';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthenticatedRequest {
  actor?: Actor;
  headers: Record<string, string | string[] | undefined>;
  /** 表單送出的 CSRF token（`_csrf`）。伺服器渲染的表單送不出自訂 header。 */
  body?: unknown;
  cookies?: Record<string, string | undefined>;
  method?: string;
  raw?: unknown;
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 三段式解析：Bearer token → session cookie → 匿名訪客。
 * token 值只從 Secret Provider 讀取，永遠不會出現在 commerce.yaml 或 log 裡。
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime,
    // esbuild 不產生 design:paramtypes，因此所有依賴都必須明確 @Inject
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const isAnonymous = this.reflector.getAllAndOverride<boolean>(IS_ANONYMOUS, targets);
    const isExternalCallback = this.reflector.getAllAndOverride<boolean>(IS_EXTERNAL_CALLBACK, targets);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (isExternalCallback) {
      // Do not put SYSTEM_ACTOR on the request. If a future callback handler
      // accidentally uses BusController, actorOf() must fail closed before provider verification.
      return true;
    }

    if (isAnonymous) {
      // 強制匿名的端點沒有 session 可以驗 CSRF，但登入本身仍是狀態變更：
      // 沒有這道檢查，攻擊者能用自己的帳密從外站把受害者「登入成」他的帳號，
      // 之後受害者填的地址與下的單全部進攻擊者的帳戶。SameSite 擋不住它——
      // 那次請求本來就不需要帶 cookie，回應的 Set-Cookie 照樣會被存下來。
      this.assertSameOrigin(request);
      request.actor = anonymousActor();
      return true;
    }

    const header = request.headers.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw && raw.toLowerCase().startsWith('bearer ')) {
      const presented = raw.slice(7).trim();

      for (const token of this.runtime.config.auth.tokens) {
        const expected = this.runtime.secrets.get(token.secretRef);
        if (!expected) continue;
        if (safeEquals(presented, expected)) {
          request.actor = {
            id: `token:${token.name}`,
            type: 'service',
            displayName: token.name,
            permissions: permissionsForRole(token.role),
          };
          return true;
        }
      }
      throw new PlatformError('UNAUTHENTICATED', 'Invalid API token');
    }

    const sessionToken = sessionTokenOf(request, this.runtime.config.http.publicUrl);
    if (sessionToken) {
      const resolved = await this.runtime.auth.resolveSession(this.runtime.database.db, sessionToken);
      if (resolved) {
        this.assertCsrf(request, sessionToken);
        request.actor = resolved.actor;
        return true;
      }
      // 過期的 cookie 不該讓公開頁面壞掉——退回訪客，讓人繼續逛。
      if (!isPublic) throw new PlatformError('UNAUTHENTICATED', 'Invalid or expired session');
    }

    if (isPublic) {
      // 訪客也會寫東西（購物車）。沒有 session 就沒有 CSRF token 可以比對，
      // 因此改用瀏覽器自己加的 Origin / Sec-Fetch-Site——與 @Anonymous() 同一套（ADR 0018）。
      this.assertSameOrigin(request);
      request.actor = anonymousActor();
      return true;
    }

    throw new PlatformError('UNAUTHENTICATED', 'Missing bearer token');
  }

  /**
   * Cookie 通過的請求才做這個檢查——Bearer token 不會被瀏覽器自動帶上，沒有 CSRF 風險。
   * 比對的是「由這次的 session token 推導出的值」，不是請求自己帶來的 CSRF cookie，
   * 因此攻擊者就算能覆寫 cookie 也偽造不出來。
   */
  /**
   * 只在瀏覽器真的表態時才判斷：`Origin` 與 `Sec-Fetch-Site` 都是瀏覽器自己加的，
   * 前端偽造不了。兩者都沒有（curl、伺服器對伺服器、測試）就放行——
   * 它們本來就不受 CSRF 影響。
   */
  private assertSameOrigin(request: AuthenticatedRequest): void {
    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return;

    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const fetchSite = header('sec-fetch-site');
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
      throw new PlatformError('FORBIDDEN', 'Cross-site form submissions are not allowed');
    }

    const origin = header('origin');
    if (!origin) return;
    try {
      if (new URL(origin).origin !== new URL(this.runtime.config.http.publicUrl).origin) {
        throw new PlatformError('FORBIDDEN', 'Cross-site form submissions are not allowed');
      }
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      throw new PlatformError('FORBIDDEN', 'Invalid Origin header');
    }
  }

  private assertCsrf(request: AuthenticatedRequest, sessionToken: string): void {
    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return;

    const header = request.headers[CSRF_HEADER];
    const headerToken = Array.isArray(header) ? header[0] : header;
    // 伺服器渲染的表單只能送欄位，送不出自訂 header——兩種來源比對的是同一個推導值。
    const body = request.body as { _csrf?: unknown } | undefined;
    const formToken = typeof body?._csrf === 'string' ? body._csrf : undefined;
    const presented = headerToken ?? formToken;

    if (!presented || !safeEquals(presented, csrfTokenFor(sessionToken))) {
      throw new PlatformError('FORBIDDEN', 'Missing or invalid CSRF token');
    }
  }
}

/** 未登入訪客的身分。權限只夠瀏覽與下單。 */
export function anonymousActor(): Actor {
  return {
    id: 'storefront',
    type: 'service',
    displayName: 'storefront',
    permissions: permissionsForRole(STOREFRONT_ROLE),
  };
}

export function actorOf(request: AuthenticatedRequest): Actor {
  if (!request.actor) throw new PlatformError('UNAUTHENTICATED', 'No actor on request');
  return request.actor;
}

export function idempotencyKeyOf(request: AuthenticatedRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

export function correlationIdOf(request: AuthenticatedRequest): string | undefined {
  const header = request.headers['x-correlation-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}
