import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { RUNTIME, type Runtime } from '../tokens';

export const IS_PUBLIC = 'commerce:public';
/** 標記不需要 API token 的端點（健康檢查、Storefront）。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const STOREFRONT_ROLE = 'storefront';

export interface AuthenticatedRequest {
  actor?: Actor;
  headers: Record<string, string | string[] | undefined>;
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

  canActivate(context: ExecutionContext): boolean {
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
    if (!raw || !raw.toLowerCase().startsWith('bearer ')) {
      throw new PlatformError('UNAUTHENTICATED', 'Missing bearer token');
    }
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
