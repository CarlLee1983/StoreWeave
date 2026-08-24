import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/orders')
export class OrderController extends BusController {
  @Post()
  async place(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.order.placeOrder', body));
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.order.listOrders', {
      status: query.status, customerEmail: query.customerEmail, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.order.getOrder', { id }));
  }

  @Post(':id/pay')
  @HttpCode(200)
  async pay(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.order.payOrder', {
      orderId: id,
      provider: body?.provider,
      method: body?.method,
    }));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.order.cancelOrder', { orderId: id, reason: body?.reason ?? 'customer request' }));
  }
}
