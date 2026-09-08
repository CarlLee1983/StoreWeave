import { Controller, Get, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  summary: { kind: 'bus', target: { kind: 'query', name: 'commerce.order.salesSummary' }, request: 'query' },
  promotions: { kind: 'bus', target: { kind: 'query', name: 'commerce.coupon.promotionPerformance' }, request: 'query' },
  partners: { kind: 'bus', target: { kind: 'query', name: 'commerce.coupon.attributionSummary' }, request: 'query' },
  rewards: { kind: 'bus', target: { kind: 'query', name: 'commerce.loyalty.outstandingRewards' }, request: 'none' },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/analytics')
export class AnalyticsController extends BusController {
  @Get('sales-summary')
  @HttpContract(routes.summary)
  async summary(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.summary, query);
  }

  /** 活動成效。資料來自核銷明細，不掃訂單全表（Spec 0005）。 */
  @Get('promotions')
  @HttpContract(routes.promotions)
  async promotions(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.promotions, query);
  }

  @Get('partners')
  @HttpContract(routes.partners)
  async partners(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.partners, query);
  }

  /** 流通在外的購物金：這是一本負債帳，經營者要看得出自己背了多少。 */
  @Get('outstanding-rewards')
  @HttpContract(routes.rewards)
  async outstandingRewards(@Req() req: AuthenticatedRequest) {
    return this.rest(req, routes.rewards, {});
  }
}
