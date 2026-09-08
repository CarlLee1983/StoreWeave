import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'platform.jobs.listDeadJobs' }, request: 'query', queryEncoding: { limit: 'number-empty-default', offset: 'number-empty-default' } },
  retry: { kind: 'bus', target: { kind: 'command', name: 'platform.jobs.retryJob' }, request: 'none', params: { jobId: 'jobId' } },
} as const satisfies Record<string, BusHttpContract>;

/** 平台維運端點：死信佇列的檢視與重送。與領域無關，只轉發到 platform.* Bus。 */
@Controller('api/v1/system')
export class SystemController extends BusController {
  @Get('jobs/dead')
  @HttpContract(routes.list)
  async listDead(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  @Post('jobs/dead/:jobId/retry')
  @HttpContract(routes.retry)
  @HttpCode(200)
  async retry(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.retry, {}, params);
  }
}
