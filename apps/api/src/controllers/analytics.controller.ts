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

  /** 活動成效。資料來自核銷明細，不掃訂單全表（Spec 0005）。 */
  @Get('promotions')
  async promotions(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.coupon.promotionPerformance', { from: query.from, to: query.to }));
  }

  @Get('partners')
  async partners(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.coupon.attributionSummary', {
      from: query.from, to: query.to, partnerCode: query.partnerCode,
    }));
  }

  /** 流通在外的購物金：這是一本負債帳，經營者要看得出自己背了多少。 */
  @Get('outstanding-rewards')
  async outstandingRewards(@Req() req: AuthenticatedRequest) {
    return ok(await this.query(req, 'commerce.loyalty.outstandingRewards', {}));
  }
}
