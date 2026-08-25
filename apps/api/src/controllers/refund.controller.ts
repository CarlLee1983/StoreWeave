import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/** Back-office queue and commands; provider I/O remains outside this HTTP boundary. */
@Controller('api/v1/refunds')
export class RefundController extends BusController {
  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.refund.listRefunds', { orderId: query.orderId, status: query.status, limit: query.limit, offset: query.offset }));
  }
  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return ok(await this.query(req, 'commerce.refund.getRefund', { id })); }
  @Post('orders/:orderId')
  @HttpCode(200)
  async request(@Req() req: AuthenticatedRequest, @Param('orderId') orderId: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.refund.requestFullRefund', { orderId, reason: body.reason }));
  }
  @Post(':id/retry')
  @HttpCode(200)
  async retry(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return ok(await this.command(req, 'commerce.refund.retryRefund', { id })); }
}
