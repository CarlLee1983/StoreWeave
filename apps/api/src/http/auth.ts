import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { csrfTokenFor } from '@storeweave/identity';
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

export const STOREFRONT_ROLE = 'storefront';

export const SESSION_COOKIE = 'commerce_session';
export const CSRF_COOKIE = 'commerce_csrf';
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
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (isAnonymous) {
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

    const sessionToken = request.cookies?.[SESSION_COOKIE];
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
