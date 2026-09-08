import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  create: { kind: 'bus', target: { kind: 'command', name: 'commerce.catalog.createProduct' }, request: 'body' },
  search: { kind: 'bus', target: { kind: 'query', name: 'commerce.catalog.searchProducts' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.catalog.getProduct' }, request: 'none', params: { id: 'id' } },
  update: { kind: 'bus', target: { kind: 'command', name: 'commerce.catalog.updateProduct' }, request: 'body', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/products')
export class CatalogController extends BusController {
  @Post()
  @HttpContract(routes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.create, body);
  }

  @Get()
  @HttpContract(routes.search)
  async search(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.search, query);
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
}
