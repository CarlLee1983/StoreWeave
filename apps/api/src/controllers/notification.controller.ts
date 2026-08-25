import { Controller, Get, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/**
 * 唯讀。手動重送通知不在這裡：重送出貨通知只是吵，重送付款連結會讓顧客拿到兩份，
 * 那是一個決策而不是一個按鈕（工單 73 的「不做的事」）。
 */
@Controller('api/v1/notification-deliveries')
export class NotificationController extends BusController {
  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.notification.listLifecycleDeliveries', {
      orderId: query.orderId, status: query.status,
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
    }));
  }
}
