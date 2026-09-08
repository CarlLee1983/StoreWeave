import { Controller, Get, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const listRoute = { kind: 'bus', target: { kind: 'query', name: 'commerce.notification.listLifecycleDeliveries' },
  request: 'query', queryEncoding: { limit: 'number', offset: 'number' },
} as const satisfies BusHttpContract;

/**
 * 唯讀。手動重送通知不在這裡：重送出貨通知只是吵，重送付款連結會讓顧客拿到兩份，
 * 那是一個決策而不是一個按鈕（工單 73 的「不做的事」）。
 */
@Controller('api/v1/notification-deliveries')
export class NotificationController extends BusController {
  @Get()
  @HttpContract(listRoute)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, listRoute, query);
  }
}
