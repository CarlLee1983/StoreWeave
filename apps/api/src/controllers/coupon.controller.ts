import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  create: { kind: 'bus', target: { kind: 'command', name: 'commerce.coupon.createCoupon' }, request: 'body' },
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.coupon.listCoupons' }, request: 'query' },
  issue: { kind: 'bus', target: { kind: 'command', name: 'commerce.coupon.issueCoupons' }, request: 'body' },
  attribution: { kind: 'bus', target: { kind: 'query', name: 'commerce.coupon.attributionSummary' }, request: 'query' },
  setStatus: { kind: 'bus', target: { kind: 'command', name: 'commerce.coupon.setCouponStatus' }, request: 'body', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

@Controller('api/v1/coupons')
export class CouponController extends BusController {
  @Post()
  @HttpContract(routes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.create, body);
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  /** 批次發券。它會寫入很多列，因此冪等鍵是必要的——重送一次不該再發一輪。 */
  @Post('issue')
  @HttpContract(routes.issue)
  async issue(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.issue, body);
  }

  @Get('attribution')
  @HttpContract(routes.attribution)
  async attribution(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.attribution, query);
  }

  /** 停用與重新啟用共用一條路徑：狀態只有一個寫入點。 */
  @Post(':id/status')
  @HttpContract(routes.setStatus)
  async setStatus(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.setStatus, body, params);
  }
}
