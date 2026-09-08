import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  create: { kind: 'bus', target: { kind: 'command', name: 'commerce.promotion.createPromotion' }, request: 'body' },
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.promotion.listPromotions' }, request: 'query' },
  quote: { kind: 'bus', target: { kind: 'query', name: 'commerce.promotion.quote' }, request: 'body' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.promotion.getPromotion' }, request: 'none', params: { id: 'id' } },
  update: { kind: 'bus', target: { kind: 'command', name: 'commerce.promotion.updatePromotion' }, request: 'body', params: { id: 'id' } },
  setStatus: { kind: 'bus', target: { kind: 'command', name: 'commerce.promotion.setPromotionStatus' }, request: 'body', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/promotions')
export class PromotionController extends BusController {
  @Post()
  @HttpContract(routes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.create, body);
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  /** 試算是無副作用的查詢，但輸入是一組商品行，只能走 POST body。 */
  @Post('quote')
  @HttpContract(routes.quote)
  async quote(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.quote, body);
  }

  @Get(':id')
  @HttpContract(routes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.get, {}, params);
  }

  @Patch(':id')
  @HttpContract(routes.update)
  async update(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.update, body, params);
  }

  /** 停用與重新啟用共用一條路徑：狀態只有一個寫入點。 */
  @Post(':id/status')
  @HttpContract(routes.setStatus)
  async setStatus(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.setStatus, body, params);
  }
}
