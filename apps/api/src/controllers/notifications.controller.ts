import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  inbox: {
    kind: 'bus', target: { kind: 'query', name: 'platform.notifications.listInbox' }, request: 'query',
    queryEncoding: { limit: 'number', offset: 'number', unreadOnly: 'boolean' },
  },
  markRead: { kind: 'bus', target: { kind: 'command', name: 'platform.notifications.markRead' }, request: 'body' },
  deliveries: {
    kind: 'bus', target: { kind: 'query', name: 'platform.notifications.listDeliveries' }, request: 'query',
    queryEncoding: { limit: 'number', offset: 'number' },
  },
} as const satisfies Record<string, BusHttpContract>;

/**
 * 站內收件匣是「自己的」：路由上沒有收件人參數，範圍由 handler 依 actor 決定。
 * 投遞證據是另一件事——那是營運看「送了沒」的清單，收件人一律遮蔽。
 */
@Controller('api/v1/notifications')
export class NotificationsController extends BusController {
  @Get()
  @HttpContract(routes.inbox)
  async inbox(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.inbox, query);
  }

  @Post('read')
  @HttpCode(200)
  @HttpContract(routes.markRead)
  async markRead(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.markRead, body);
  }

  @Get('deliveries')
  @HttpContract(routes.deliveries)
  async deliveries(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.deliveries, query);
  }
}
