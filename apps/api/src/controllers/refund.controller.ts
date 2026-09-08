import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.refund.listRefunds' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.refund.getRefund' }, request: 'none', params: { id: 'id' } },
  request: { kind: 'bus', target: { kind: 'command', name: 'commerce.refund.requestFullRefund' }, request: 'body', params: { orderId: 'orderId' } },
  retry: { kind: 'bus', target: { kind: 'command', name: 'commerce.refund.retryRefund' }, request: 'none', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

/** Back-office queue and commands; provider I/O remains outside this HTTP boundary. */
@Controller('api/v1/refunds')
export class RefundController extends BusController {
  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }
  @Get(':id')
  @HttpContract(routes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) { return this.rest(req, routes.get, {}, params); }
  @Post('orders/:orderId')
  @HttpContract(routes.request)
  @HttpCode(200)
  async request(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.request, body, params);
  }
  @Post(':id/retry')
  @HttpContract(routes.retry)
  @HttpCode(200)
  async retry(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) { return this.rest(req, routes.retry, {}, params); }
}
