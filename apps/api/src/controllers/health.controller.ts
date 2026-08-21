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

  // 這支不是 @Public()：它會回傳 provider 與 extension 的錯誤訊息、佇列深度與 worker id，
  // 那是維運視圖而不是負載平衡器需要的東西。live / ready 才是給探針用的。
  @Get('dependencies')
  async deps(@Res() reply: FastifyReply) {
    const result = await dependencies(this.runtime);
    void reply.status(result.status === 'down' ? 503 : 200).send(result);
  }
}
