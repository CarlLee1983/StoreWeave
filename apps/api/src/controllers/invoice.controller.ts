import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/**
 * Invoices are driven by order and refund events (ticket 66); this surface is
 * read-only plus a re-attempt of an already-decided action. There is no manual
 * issue or manual void here on purpose.
 */
@Controller('api/v1/invoices')
export class InvoiceController extends BusController {
  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.invoice.list', {
      orderId: query.orderId, status: query.status,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.invoice.get', { id }));
  }

  @Post(':id/retry-issue')
  @HttpCode(200)
  async retryIssue(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.invoice.retryIssue', { id }));
  }

  @Post(':id/retry-void')
  @HttpCode(200)
  async retryVoid(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.invoice.retryVoid', { id }));
  }
}
