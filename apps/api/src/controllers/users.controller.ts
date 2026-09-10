import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: {
    kind: 'bus', target: { kind: 'query', name: 'platform.identity.listUsers' }, request: 'query',
    queryEncoding: { limit: 'number', offset: 'number' },
  },
  create: { kind: 'bus', target: { kind: 'command', name: 'platform.identity.createUser' }, request: 'body' },
  setStatus: {
    kind: 'bus', target: { kind: 'command', name: 'platform.identity.setUserStatus' }, request: 'body',
    params: { id: 'userId' },
  },
} as const satisfies Record<string, BusHttpContract>;

/**
 * 後台操作者帳號。B08 交付時這些命令只有 Bus 與 CLI 入口，做不出帳號管理 UI（B13 片4）。
 * 授權、稽核與「不能停用自己」那條 policy 全部留在 handler 那一層，這裡只做轉換。
 */
@Controller('api/v1/users')
export class UsersController extends BusController {
  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  @Post()
  @HttpCode(201)
  @HttpContract(routes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.create, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @HttpContract(routes.setStatus)
  async setStatus(
    @Req() req: AuthenticatedRequest,
    @Param() params: Record<string, string>,
    @Body() body: Record<string, unknown>,
  ) {
    return this.rest(req, routes.setStatus, body, params);
  }
}
