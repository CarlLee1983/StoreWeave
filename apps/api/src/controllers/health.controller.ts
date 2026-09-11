import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { JsonSchema7Type } from 'zod-to-json-schema';
import { dependencies, liveness, operationalMetrics, readiness } from '@storeweave/kernel';
import { actorOf, Anonymous, BearerOnly, type AuthenticatedRequest, Public } from '../http/auth';
import { HttpContract, type RawHttpContract } from '../http/contract';
import { RUNTIME, type Runtime } from '../tokens';

const checkSchema = {
  type: 'object', required: ['name', 'status'], additionalProperties: false,
  properties: { name: { type: 'string' }, status: { type: 'string', enum: ['pass', 'warn', 'fail'] }, detail: { type: 'string' } },
} as const satisfies JsonSchema7Type;
const healthSchema = {
  type: 'object', required: ['status', 'checks'], additionalProperties: false,
  properties: { status: { type: 'string', enum: ['ok', 'degraded', 'down'] }, checks: { type: 'array', items: checkSchema } },
} as const satisfies JsonSchema7Type;
const metricsSchema = {
  type: 'object', required: ['status', 'outbox', 'jobs', 'worker', 'scheduler', 'mail', 'storage'], additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
    outbox: { type: 'object', required: ['pending', 'dead', 'oldestPendingAgeSeconds'], additionalProperties: false,
      properties: { pending: { type: 'number' }, dead: { type: 'number' }, oldestPendingAgeSeconds: { type: ['number', 'null'] } } },
    jobs: { type: 'object', required: ['pending', 'running', 'dead', 'quarantined'], additionalProperties: false,
      properties: { pending: { type: 'number' }, running: { type: 'number' }, dead: { type: 'number' }, quarantined: { type: 'number' } } },
    worker: { type: 'object', required: ['lastSeenAgeSeconds'], additionalProperties: false,
      properties: { lastSeenAgeSeconds: { type: ['number', 'null'] } } },
    scheduler: { type: 'object', required: ['total', 'paused', 'skippedCatchup', 'skippedPaused', 'skippedOverlap'], additionalProperties: false,
      properties: { total: { type: 'number' }, paused: { type: 'number' }, skippedCatchup: { type: 'number' }, skippedPaused: { type: 'number' }, skippedOverlap: { type: 'number' } } },
    mail: { type: 'object', required: ['enabled', 'pending', 'partial', 'unknown', 'rejected'], additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, pending: { type: 'number' }, partial: { type: 'number' }, unknown: { type: 'number' }, rejected: { type: 'number' } } },
    storage: { type: 'object', required: ['available'], additionalProperties: false, properties: { available: { type: 'boolean' } } },
  },
} as const satisfies JsonSchema7Type;
const routes = {
  live: { kind: 'raw', request: 'none', statuses: [200], output: {
    type: 'object', required: ['status', 'uptimeSeconds'], additionalProperties: false,
    properties: { status: { type: 'string', const: 'ok' }, uptimeSeconds: { type: 'number' } },
  } },
  ready: { kind: 'raw', request: 'none', statuses: [200, 503], output: healthSchema },
  deps: { kind: 'raw', request: 'none', statuses: [200, 503], output: healthSchema },
  metrics: { kind: 'raw', request: 'none', statuses: [200, 503], output: metricsSchema },
} as const satisfies Record<string, RawHttpContract>;

@Controller('health')
export class HealthController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  // 探針端點不解析 cookie：省掉每次探測的 session 查詢，也沒有任何身分外洩面。
  @Public()
  @Anonymous()
  @Get('live')
  @HttpContract(routes.live)
  async live() {
    return liveness();
  }

  @Public()
  @Anonymous()
  @Get('ready')
  @HttpContract(routes.ready)
  async ready(@Res() reply: FastifyReply) {
    const result = await readiness(this.runtime);
    void reply.status(result.status === 'ok' ? 200 : 503).send(result);
  }

  // 這支不是 @Public()：它會回傳 provider 與 extension 的錯誤訊息、佇列深度與 worker id，
  // 那是維運視圖而不是負載平衡器需要的東西。live / ready 才是給探針用的。
  @Get('dependencies')
  @HttpContract(routes.deps)
  async deps(@Res() reply: FastifyReply) {
    const result = await dependencies(this.runtime);
    void reply.status(result.status === 'down' ? 503 : 200).send(result);
  }

  // Same authenticated boundary as dependencies, but only stable numeric
  // counters. Monitoring agents must never scrape provider errors or worker ids.
  @BearerOnly()
  @Get('metrics')
  @HttpContract(routes.metrics)
  async metrics(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    this.runtime.authorization.assert({ actor: actorOf(request), permission: 'jobs:read' });
    const result = await operationalMetrics(this.runtime);
    void reply.status(result.status === 'down' ? 503 : 200).send(result);
  }
}
