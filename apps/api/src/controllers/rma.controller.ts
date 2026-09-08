import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.rma.listRmas' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.rma.getRma' }, request: 'none', params: { id: 'id' } },
  create: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.createRma' }, request: 'body' },
  approve: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.approveRma' }, request: 'body', params: { id: 'id' } },
  requestInformation: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.requestInformation' }, request: 'body', params: { id: 'id' } },
  reject: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.rejectRma' }, request: 'body', params: { id: 'id' } },
  receive: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.receiveRma' }, request: 'body', params: { id: 'id' } },
  requestRefund: { kind: 'bus', target: { kind: 'command', name: 'commerce.rma.requestRefund' }, request: 'body', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

/** RMA is an operations workflow; provider refund execution stays in the worker boundary. */
@Controller('api/v1/rmas')
export class RmaController extends BusController {
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

  @Post()
  @HttpCode(200)
  @HttpContract(routes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.create, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @HttpContract(routes.approve)
  async approve(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.approve, body, params);
  }

  @Post(':id/request-information')
  @HttpCode(200)
  @HttpContract(routes.requestInformation)
  async requestInformation(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.requestInformation, body, params);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @HttpContract(routes.reject)
  async reject(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.reject, body, params);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @HttpContract(routes.receive)
  async receive(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.receive, body, params);
  }

  @Post(':id/request-refund')
  @HttpCode(200)
  @HttpContract(routes.requestRefund)
  async requestRefund(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.requestRefund, body, params);
  }
}
