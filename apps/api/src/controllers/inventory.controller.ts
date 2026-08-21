import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/inventory')
export class InventoryController extends BusController {
  @Post('adjust')
  @HttpCode(200)
  async adjust(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.inventory.adjustStock', body));
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.inventory.listStock', {
      belowQuantity: query.belowQuantity, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':productId')
  async get(@Req() req: AuthenticatedRequest, @Param('productId') productId: string) {
    return ok(await this.query(req, 'commerce.inventory.getStock', { productId }));
  }
}
