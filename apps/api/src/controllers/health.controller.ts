import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { dependencies, liveness, readiness } from '@storeweave/kernel';
import { Public } from '../http/auth';
import { RUNTIME, type Runtime } from '../tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Public()
  @Get('live')
  async live() {
    return liveness();
  }

  @Public()
  @Get('ready')
  async ready(@Res() reply: FastifyReply) {
    const result = await readiness(this.runtime);
    void reply.status(result.status === 'ok' ? 200 : 503).send(result);
  }

  @Public()
  @Get('dependencies')
  async deps(@Res() reply: FastifyReply) {
    const result = await dependencies(this.runtime);
    void reply.status(result.status === 'down' ? 503 : 200).send(result);
  }
}
