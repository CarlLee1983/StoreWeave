import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Runtime } from '@storeweave/kernel';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import { RUNTIME } from '../tokens';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  updateSettings: { kind: 'bus', target: { kind: 'command', name: 'platform.site.updateSettings' }, request: 'body' },
} as const satisfies Record<string, BusHttpContract>;

/** Operator-only settings; the public chrome query intentionally omits notification recipients. */
@Controller('api/v1/site')
export class SiteController extends BusController {
  constructor(@Inject(RUNTIME) runtime: Runtime) { super(runtime); }

  @Post('settings')
  @HttpCode(200)
  @HttpContract(routes.updateSettings)
  async updateSettings(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(request, routes.updateSettings, body);
  }
}
