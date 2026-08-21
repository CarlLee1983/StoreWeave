import { Controller, Get, Inject } from '@nestjs/common';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ok } from '../http/envelope';
import { RELEASE, RUNTIME, type ReleaseInfo, type Runtime } from '../tokens';

/** 契約自省：Command / Query / Event / 權限清單，供 CLI、Admin 與工具使用。 */
@Controller('api/v1/meta')
export class MetaController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(RELEASE) private readonly release: ReleaseInfo,
  ) {}

  @Get()
  info() {
    return ok({
      release: this.release.version,
      platformVersion: this.runtime.platformVersion,
      store: { id: this.runtime.config.store.id, name: this.runtime.config.store.name },
      node: process.version,
    });
  }

  @Get('commands')
  commands() {
    return ok({
      items: this.runtime.commands.list().map((c) => ({
        name: c.descriptor.name,
        version: c.descriptor.version,
        owner: c.owner,
        permission: c.descriptor.permission,
        idempotency: c.descriptor.idempotency,
        summary: c.descriptor.summary,
        input: zodToJsonSchema(c.descriptor.input as never, { target: 'jsonSchema7' }),
      })),
    });
  }

  @Get('queries')
  queries() {
    return ok({
      items: this.runtime.queries.list().map((q) => ({
        name: q.descriptor.name,
        version: q.descriptor.version,
        owner: q.owner,
        permission: q.descriptor.permission,
        summary: q.descriptor.summary,
        input: zodToJsonSchema(q.descriptor.input as never, { target: 'jsonSchema7' }),
      })),
    });
  }

  @Get('events')
  events() {
    return ok({
      items: this.runtime.events.listEvents().map((e) => ({
        name: e.name,
        version: e.version,
        summary: e.summary,
        subscribers: this.runtime.events.subscribersFor(e.name).map((s) => s.subscriberId),
        payload: zodToJsonSchema(e.payload as never, { target: 'jsonSchema7' }),
      })),
    });
  }

  @Get('permissions')
  permissions() {
    return ok({ items: this.runtime.authorization.permissions.list() });
  }
}
