import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/** RMA is an operations workflow; provider refund execution stays in the worker boundary. */
@Controller('api/v1/rmas')
export class RmaController extends BusController {
  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.rma.listRmas', {
      orderId: query.orderId, status: query.status, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.rma.getRma', { id }));
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.rma.createRma', body));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.rma.approveRma', { id, note: body.note }));
  }

  @Post(':id/request-information')
  @HttpCode(200)
  async requestInformation(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.rma.requestInformation', { id, note: body.note }));
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.rma.rejectRma', { id, note: body.note }));
  }

  @Post(':id/receive')
  @HttpCode(200)
  async receive(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.rma.receiveRma', { id, lines: body.lines }));
  }

  @Post(':id/request-refund')
  @HttpCode(200)
  async requestRefund(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.rma.requestRefund', { id, reason: body.reason }));
  }
}
