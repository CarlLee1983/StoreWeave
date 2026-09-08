import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.invoice.list' }, request: 'query', queryEncoding: { limit: 'number', offset: 'number' } },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.invoice.get' }, request: 'none', params: { id: 'id' } },
  retryIssue: { kind: 'bus', target: { kind: 'command', name: 'commerce.invoice.retryIssue' }, request: 'none', params: { id: 'id' } },
  retryVoid: { kind: 'bus', target: { kind: 'command', name: 'commerce.invoice.retryVoid' }, request: 'none', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

/**
 * Invoices are driven by order and refund events (ticket 66); this surface is
 * read-only plus a re-attempt of an already-decided action. There is no manual
 * issue or manual void here on purpose.
 */
@Controller('api/v1/invoices')
export class InvoiceController extends BusController {
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

  @Post(':id/retry-issue')
  @HttpContract(routes.retryIssue)
  @HttpCode(200)
  async retryIssue(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.retryIssue, {}, params);
  }

  @Post(':id/retry-void')
  @HttpContract(routes.retryVoid)
  @HttpCode(200)
  async retryVoid(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.retryVoid, {}, params);
  }
}
