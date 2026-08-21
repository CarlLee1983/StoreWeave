import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/products')
export class CatalogController extends BusController {
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.catalog.createProduct', body));
  }

  @Get()
  async search(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.catalog.searchProducts', {
      q: query.q, status: query.status, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.catalog.getProduct', { id }));
  }

  @Patch(':id')
  async update(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.catalog.updateProduct', { ...body, id }));
  }
}
