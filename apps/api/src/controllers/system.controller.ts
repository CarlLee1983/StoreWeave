import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { HttpContract, type BusHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';

const routes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'platform.jobs.listDeadJobs' }, request: 'query', queryEncoding: { limit: 'number-empty-default', offset: 'number-empty-default' } },
  retry: { kind: 'bus', target: { kind: 'command', name: 'platform.jobs.retryJob' }, request: 'none', params: { jobId: 'jobId' } },
  listQuarantined: { kind: 'bus', target: { kind: 'query', name: 'platform.jobs.listQuarantinedJobs' }, request: 'query', queryEncoding: { limit: 'number-empty-default', offset: 'number-empty-default' } },
  redriveQuarantined: { kind: 'bus', target: { kind: 'command', name: 'platform.jobs.redriveQuarantinedJob' }, request: 'none', params: { jobId: 'jobId' } },
  listOutboxFailures: { kind: 'bus', target: { kind: 'query', name: 'platform.outbox.listFailures' }, request: 'query', queryEncoding: { limit: 'number-empty-default', offset: 'number-empty-default' } },
  redriveOutboxFailure: { kind: 'bus', target: { kind: 'command', name: 'platform.outbox.redriveFailure' }, request: 'body', params: { outboxId: 'outboxId' } },
} as const satisfies Record<string, BusHttpContract>;

/** 平台維運端點：死信與 quarantine 的檢視及受審計重送。與領域無關，只轉發到 platform.* Bus。 */
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

  @Get('jobs/quarantined')
  @HttpContract(routes.listQuarantined)
  async listQuarantined(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.listQuarantined, query);
  }

  @Post('jobs/quarantined/:jobId/redrive')
  @HttpContract(routes.redriveQuarantined)
  @HttpCode(200)
  async redriveQuarantined(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.redriveQuarantined, {}, params);
  }

  @Get('outbox/failures')
  @HttpContract(routes.listOutboxFailures)
  async listOutboxFailures(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.listOutboxFailures, query);
  }

  @Post('outbox/failures/:outboxId/redrive')
  @HttpContract(routes.redriveOutboxFailure)
  @HttpCode(200)
  async redriveOutboxFailure(
    @Req() req: AuthenticatedRequest,
    @Param() params: Record<string, string>,
    @Body() body: unknown,
  ) {
    return this.rest(req, routes.redriveOutboxFailure, body ?? {}, params);
  }
}
