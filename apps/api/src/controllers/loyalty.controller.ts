import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/**
 * 等級門檻與購物金規則是店家維護的商業資料，不是程式常數。
 * 讀取沿用既有的權限（等級對顧客公開、設定屬於營運），寫入走 loyalty:write。
 */
@Controller('api/v1/loyalty')
export class LoyaltyController extends BusController {
  @Get('settings')
  async settings(@Req() req: AuthenticatedRequest) {
    return ok(await this.query(req, 'commerce.loyalty.getRewardSettings', {}));
  }

  @Patch('settings')
  async updateSettings(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.loyalty.updateRewardSettings', body));
  }

  @Get('tiers')
  async tiers(@Req() req: AuthenticatedRequest) {
    return ok(await this.query(req, 'commerce.loyalty.listTiers', {}));
  }

  /** 名稱是等級的識別：同名是修改，不是再開一級，所以這裡是 PUT 而不是 POST。 */
  @Put('tiers')
  @HttpCode(200)
  async saveTier(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.loyalty.saveTier', body));
  }

  @Delete('tiers/:name')
  @HttpCode(200)
  async removeTier(@Req() req: AuthenticatedRequest, @Param('name') name: string) {
    return ok(await this.command(req, 'commerce.loyalty.removeTier', { name }));
  }
}
