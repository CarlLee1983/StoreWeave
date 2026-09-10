import type { Type } from '@nestjs/common';
import type { BaseConfig } from '@storeweave/config';
import type { IssuedSession } from '@storeweave/identity';
import type { Runtime, StorefrontTheme } from '@storeweave/kernel';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from './http/auth';

export const HTTP_ADAPTER = Symbol('STOREWEAVE_HTTP_ADAPTER');
export interface ReleaseHttpAdapter {
  readonly releaseId: string;
  readonly anonymousRole: string | null;
  /**
   * Storefront 的路由來自模組宣告的頁面，所以組裝 controller 需要 runtime 與 Theme，
   * 不只是設定（ADR 0045）。
   */
  controllers(config: BaseConfig, context: { runtime: Runtime; theme?: StorefrontTheme }): Type[];
  startSession(runtime: Runtime, request: AuthenticatedRequest, reply: FastifyReply, session: IssuedSession): Promise<string | null>;
}
