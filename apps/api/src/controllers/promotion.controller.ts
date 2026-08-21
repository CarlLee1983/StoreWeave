import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/promotions')
export class PromotionController extends BusController {
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.promotion.createPromotion', body));
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.promotion.listPromotions', {
      status: query.status, activeAt: query.activeAt, limit: query.limit, offset: query.offset,
    }));
  }

  /** 試算是無副作用的查詢，但輸入是一組商品行，只能走 POST body。 */
  @Post('quote')
  async quote(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.query(req, 'commerce.promotion.quote', body));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.promotion.getPromotion', { id }));
  }

  @Patch(':id')
  async update(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.promotion.updatePromotion', { ...body, id }));
  }

  /** 停用與重新啟用共用一條路徑：狀態只有一個寫入點。 */
  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.promotion.setPromotionStatus', { id, status: body.status }));
  }
}
