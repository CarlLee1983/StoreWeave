import { Controller, Get, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/analytics')
export class AnalyticsController extends BusController {
  @Get('sales-summary')
  async summary(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.order.salesSummary', { from: query.from, to: query.to }));
  }
}
