import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

@Controller('api/v1/coupons')
export class CouponController extends BusController {
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.coupon.createCoupon', body));
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.coupon.listCoupons', {
      status: query.status, promotionId: query.promotionId, customerId: query.customerId,
      limit: query.limit, offset: query.offset,
    }));
  }

  /** 批次發券。它會寫入很多列，因此冪等鍵是必要的——重送一次不該再發一輪。 */
  @Post('issue')
  async issue(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.coupon.issueCoupons', body));
  }

  @Get('attribution')
  async attribution(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.coupon.attributionSummary', {
      from: query.from, to: query.to, partnerCode: query.partnerCode,
    }));
  }

  /** 停用與重新啟用共用一條路徑：狀態只有一個寫入點。 */
  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.coupon.setCouponStatus', { id, status: body.status }));
  }
}
