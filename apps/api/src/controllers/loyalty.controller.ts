import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  settings: { kind: 'bus', target: { kind: 'query', name: 'commerce.loyalty.getRewardSettings' }, request: 'none' },
  updateSettings: { kind: 'bus', target: { kind: 'command', name: 'commerce.loyalty.updateRewardSettings' }, request: 'body' },
  tiers: { kind: 'bus', target: { kind: 'query', name: 'commerce.loyalty.listTiers' }, request: 'none' },
  saveTier: { kind: 'bus', target: { kind: 'command', name: 'commerce.loyalty.saveTier' }, request: 'body' },
  removeTier: { kind: 'bus', target: { kind: 'command', name: 'commerce.loyalty.removeTier' }, request: 'none', params: { name: 'name' } },
} as const satisfies Record<string, BusHttpContract>;

/**
 * 等級門檻與購物金規則是店家維護的商業資料，不是程式常數。
 * 讀取沿用既有的權限（等級對顧客公開、設定屬於營運），寫入走 loyalty:write。
 */
@Controller('api/v1/loyalty')
export class LoyaltyController extends BusController {
  @Get('settings')
  @HttpContract(routes.settings)
  async settings(@Req() req: AuthenticatedRequest) {
    return this.rest(req, routes.settings, {});
  }

  @Patch('settings')
  @HttpContract(routes.updateSettings)
  async updateSettings(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.updateSettings, body);
  }

  @Get('tiers')
  @HttpContract(routes.tiers)
  async tiers(@Req() req: AuthenticatedRequest) {
    return this.rest(req, routes.tiers, {});
  }

  /** 名稱是等級的識別：同名是修改，不是再開一級，所以這裡是 PUT 而不是 POST。 */
  @Put('tiers')
  @HttpCode(200)
  @HttpContract(routes.saveTier)
  async saveTier(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.saveTier, body);
  }

  @Delete('tiers/:name')
  @HttpCode(200)
  @HttpContract(routes.removeTier)
  async removeTier(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.removeTier, {}, params);
  }
}
