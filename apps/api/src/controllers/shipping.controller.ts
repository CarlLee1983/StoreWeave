import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

const booleanQuery = (value: string | undefined): boolean | string | undefined => {
  if (value === undefined || value === 'true') return value === undefined ? undefined : true;
  if (value === 'false') return false;
  return value;
};

/**
 * 物流管理的 HTTP 邊界只轉送到 Shipping module 的 Command / Query Bus。
 * 付款與物流供應商的實際整合不從這個 controller 直連。
 */
@Controller('api/v1/shipping')
export class ShippingController extends BusController {
  @Get('methods')
  async listMethods(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.shipping.listShippingMethods', {
      enabled: booleanQuery(query.enabled), limit: query.limit, offset: query.offset,
    }));
  }

  @Post('methods')
  async createMethod(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.shipping.createShippingMethod', body));
  }

  @Get('methods/:id')
  async getMethod(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.shipping.getShippingMethod', { id }));
  }

  @Patch('methods/:id')
  async updateMethod(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.shipping.updateShippingMethod', { ...body, id }));
  }

  @Get('shipments/:id')
  async getShipment(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.shipping.getShipment', { id }));
  }

  @Post('shipments')
  async createShipment(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.shipping.createShipment', body));
  }

  @Post('shipments/:id/stage')
  async advanceShipmentStage(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.shipping.advanceShipmentStage', { shipmentId: id, status: body.status }));
  }
}
