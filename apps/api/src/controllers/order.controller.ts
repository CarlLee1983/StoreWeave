import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  place: { kind: 'bus', target: { kind: 'command', name: 'commerce.order.placeOrder' }, request: 'body' },
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.order.listOrders' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.order.getOrder' }, request: 'none', params: { id: 'id' } },
  pay: { kind: 'bus', target: { kind: 'command', name: 'commerce.order.payOrder' }, request: 'body', params: { id: 'orderId' } },
  cancel: { kind: 'bus', target: { kind: 'command', name: 'commerce.order.cancelOrder' }, request: 'body', params: { id: 'orderId' }, nullAsMissing: ['reason'] },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/orders')
export class OrderController extends BusController {
  @Post()
  @HttpContract(routes.place)
  async place(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.place, body);
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  @Get(':id')
  @HttpContract(routes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.get, {}, params);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @HttpContract(routes.pay)
  async pay(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.pay, body, params);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @HttpContract(routes.cancel)
  async cancel(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.cancel, body, params);
  }
}
