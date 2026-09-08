import type { Type } from '@nestjs/common';
import type { BaseConfig } from '@storeweave/config';
import type { IssuedSession } from '@storeweave/identity';
import type { Runtime } from '@storeweave/kernel';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from './http/auth';

export const HTTP_ADAPTER = Symbol('STOREWEAVE_HTTP_ADAPTER');
export interface ReleaseHttpAdapter {
  readonly releaseId: string;
  readonly anonymousRole: string | null;
  controllers(config: BaseConfig): Type[];
  startSession(runtime: Runtime, request: AuthenticatedRequest, reply: FastifyReply, session: IssuedSession): Promise<string | null>;
}
