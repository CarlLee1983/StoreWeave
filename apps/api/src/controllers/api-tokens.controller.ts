import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'platform.identity.listApiTokens' }, request: 'none' },
  issue: { kind: 'bus', target: { kind: 'command', name: 'platform.identity.issueApiToken' }, request: 'body' },
  revoke: {
    kind: 'bus', target: { kind: 'command', name: 'platform.identity.revokeApiToken' }, request: 'none',
    params: { name: 'name' },
  },
} as const satisfies Record<string, BusHttpContract>;

/**
 * 機器對機器的 token（ADR 0043）。秘密只在簽發的回應裡出現一次，列表讀不回來——
 * 所以這裡沒有「重看一次」的端點，只有重新簽發。
 */
@Controller('api/v1/system/api-tokens')
export class ApiTokensController extends BusController {
  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest) {
    return this.rest(req, routes.list, {});
  }

  @Post()
  @HttpCode(201)
  @HttpContract(routes.issue)
  async issue(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.issue, body);
  }

  @Post(':name/revoke')
  @HttpCode(200)
  @HttpContract(routes.revoke)
  async revoke(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.revoke, {}, params);
  }
}
