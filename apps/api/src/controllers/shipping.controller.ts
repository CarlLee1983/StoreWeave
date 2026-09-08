import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  listMethods: { kind: 'bus', target: { kind: 'query', name: 'commerce.shipping.listShippingMethods' }, request: 'query', queryEncoding: { enabled: 'boolean' } },
  createMethod: { kind: 'bus', target: { kind: 'command', name: 'commerce.shipping.createShippingMethod' }, request: 'body' },
  getMethod: { kind: 'bus', target: { kind: 'query', name: 'commerce.shipping.getShippingMethod' }, request: 'none', params: { id: 'id' } },
  updateMethod: { kind: 'bus', target: { kind: 'command', name: 'commerce.shipping.updateShippingMethod' }, request: 'body', params: { id: 'id' } },
  getShipmentLabelInfo: { kind: 'bus', target: { kind: 'query', name: 'commerce.shipping.getShipmentLabelInfo' }, request: 'none', params: { id: 'id' } },
  getShipment: { kind: 'bus', target: { kind: 'query', name: 'commerce.shipping.getShipment' }, request: 'none', params: { id: 'id' } },
  createShipment: { kind: 'bus', target: { kind: 'command', name: 'commerce.shipping.createShipment' }, request: 'body' },
  advanceShipmentStage: { kind: 'bus', target: { kind: 'command', name: 'commerce.shipping.advanceShipmentStage' }, request: 'body', params: { id: 'shipmentId' } },
} as const satisfies Record<string, BusHttpContract>;

/**
 * 物流管理的 HTTP 邊界只轉送到 Shipping module 的 Command / Query Bus。
 * 付款與物流供應商的實際整合不從這個 controller 直連。
 */
@Controller('api/v1/shipping')
export class ShippingController extends BusController {
  @Get('methods')
  @HttpContract(routes.listMethods)
  async listMethods(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.listMethods, query);
  }

  @Post('methods')
  @HttpContract(routes.createMethod)
  async createMethod(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.createMethod, body);
  }

  @Get('methods/:id')
  @HttpContract(routes.getMethod)
  async getMethod(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.getMethod, {}, params);
  }

  @Patch('methods/:id')
  @HttpContract(routes.updateMethod)
  async updateMethod(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.updateMethod, body, params);
  }

  /** Returns an opaque carrier label handle only to actors with shipping:label-read. */
  @Get('shipments/:id/label')
  @Header('Cache-Control', 'no-store')
  @HttpContract(routes.getShipmentLabelInfo)
  async getShipmentLabelInfo(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.getShipmentLabelInfo, {}, params);
  }

  @Get('shipments/:id')
  @HttpContract(routes.getShipment)
  async getShipment(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.getShipment, {}, params);
  }

  @Post('shipments')
  @HttpContract(routes.createShipment)
  async createShipment(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.createShipment, body);
  }

  @Post('shipments/:id/stage')
  @HttpContract(routes.advanceShipmentStage)
  async advanceShipmentStage(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.advanceShipmentStage, body, params);
  }
}
