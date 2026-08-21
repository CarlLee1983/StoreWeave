import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { csrfTokenFor } from '@storeweave/identity';
import { RUNTIME, type Runtime } from '../tokens';

export const IS_PUBLIC = 'commerce:public';
/** 標記不需要 API token 的端點（健康檢查、Storefront）。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const STOREFRONT_ROLE = 'storefront';

export const SESSION_COOKIE = 'commerce_session';
export const CSRF_COOKIE = 'commerce_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthenticatedRequest {
  actor?: Actor;
  headers: Record<string, string | string[] | undefined>;
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
 * Bearer token → 角色 → Actor。
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
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (isPublic) {
      request.actor = {
        id: 'storefront',
        type: 'service',
        displayName: 'storefront',
        permissions: permissionsForRole(STOREFRONT_ROLE),
      };
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
      if (!resolved) throw new PlatformError('UNAUTHENTICATED', 'Invalid or expired session');
      this.assertCsrf(request, sessionToken);
      request.actor = resolved.actor;
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
    if (!headerToken || !safeEquals(headerToken, csrfTokenFor(sessionToken))) {
      throw new PlatformError('FORBIDDEN', 'Missing or invalid CSRF token');
    }
  }
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
