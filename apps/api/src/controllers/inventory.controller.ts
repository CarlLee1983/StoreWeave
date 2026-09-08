import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  adjust: { kind: 'bus', target: { kind: 'command', name: 'commerce.inventory.adjustStock' }, request: 'body' },
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.inventory.listStock' }, request: 'query', queryEncoding: { productIds: 'csv' } },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.inventory.getStock' }, request: 'none', params: { productId: 'productId' } },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/inventory')
export class InventoryController extends BusController {
  @Post('adjust')
  @HttpContract(routes.adjust)
  @HttpCode(200)
  async adjust(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.adjust, body);
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  @Get(':productId')
  @HttpContract(routes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.get, {}, params);
  }
}
