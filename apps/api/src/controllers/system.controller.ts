import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/** 平台維運端點：死信佇列的檢視與重送。與領域無關，只轉發到 platform.* Bus。 */
@Controller('api/v1/system')
export class SystemController extends BusController {
  @Get('jobs/dead')
  async listDead(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(
      await this.query(req, 'platform.jobs.listDeadJobs', {
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
      }),
    );
  }

  @Post('jobs/dead/:jobId/retry')
  @HttpCode(200)
  async retry(@Req() req: AuthenticatedRequest, @Param('jobId') jobId: string) {
    return ok(await this.command(req, 'platform.jobs.retryJob', { jobId }));
  }
}
