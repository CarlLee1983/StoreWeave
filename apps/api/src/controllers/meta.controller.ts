import { Controller, Get, Inject } from '@nestjs/common';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';
import { ok } from '../http/envelope';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { RELEASE, RUNTIME, type ReleaseInfo, type Runtime } from '../tokens';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema7Type;
const response = (data: JsonSchema7Type) => ({
  type: 'object', required: ['success', 'data'], additionalProperties: false,
  properties: { success: { type: 'boolean', const: true }, data },
} satisfies JsonSchema7Type);
const jsonSchema = { type: 'object' } as const satisfies JsonSchema7Type;
const commandItem = {
  type: 'object', required: ['name', 'version', 'owner', 'permission', 'idempotency', 'input', 'output'], additionalProperties: false,
  properties: {
    name: { type: 'string' }, version: { type: 'integer' }, owner: { type: 'string' }, permission: { type: 'string' },
    idempotency: { type: 'string', enum: ['required', 'optional', 'none'] }, summary: { type: 'string' }, input: jsonSchema, output: jsonSchema,
  },
} as const satisfies JsonSchema7Type;
const queryItem = {
  type: 'object', required: ['name', 'version', 'owner', 'permission', 'input', 'output'], additionalProperties: false,
  properties: {
    name: { type: 'string' }, version: { type: 'integer' }, owner: { type: 'string' }, permission: { type: 'string' },
    summary: { type: 'string' }, input: jsonSchema, output: jsonSchema,
  },
} as const satisfies JsonSchema7Type;
const eventItem = {
  type: 'object', required: ['name', 'version', 'subscribers', 'payload'], additionalProperties: false,
  properties: {
    name: { type: 'string' }, version: { type: 'integer' }, summary: { type: 'string' },
    subscribers: { type: 'array', items: { type: 'string' } }, payload: jsonSchema,
  },
} as const satisfies JsonSchema7Type;
const routes = {
  info: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['release', 'platformVersion', 'store', 'node'], additionalProperties: false,
    properties: {
      release: { type: 'string' }, platformVersion: { type: 'string' }, node: { type: 'string' },
      store: { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' } } },
    },
  }) },
  commands: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: commandItem } },
  }) },
  queries: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: queryItem } },
  }) },
  events: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: eventItem } },
  }) },
  permissions: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: {
      type: 'object', required: ['key', 'description', 'owner'], additionalProperties: false,
      properties: { key: { type: 'string' }, description: { type: 'string' }, owner: { type: 'string' } },
    } } },
  }) },
} as const satisfies Record<string, DirectHttpContract>;

/** 契約自省：Command / Query / Event / 權限清單，供 CLI、Admin 與工具使用。 */
@Controller('api/v1/meta')
export class MetaController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(RELEASE) private readonly release: ReleaseInfo,
  ) {}

  @Get()
  @HttpContract(routes.info)
  info() {
    return ok({
      release: this.release.version,
      platformVersion: this.runtime.platformVersion,
      store: { id: this.runtime.config.store.id, name: this.runtime.config.store.name },
      node: process.version,
    });
  }

  @Get('commands')
  @HttpContract(routes.commands)
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
        output: zodToJsonSchema(c.descriptor.output as never, { target: 'jsonSchema7' }),
      })),
    });
  }

  @Get('queries')
  @HttpContract(routes.queries)
  queries() {
    return ok({
      items: this.runtime.queries.list().map((q) => ({
        name: q.descriptor.name,
        version: q.descriptor.version,
        owner: q.owner,
        permission: q.descriptor.permission,
        summary: q.descriptor.summary,
        input: zodToJsonSchema(q.descriptor.input as never, { target: 'jsonSchema7' }),
        output: zodToJsonSchema(q.descriptor.output as never, { target: 'jsonSchema7' }),
      })),
    });
  }

  @Get('events')
  @HttpContract(routes.events)
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
  @HttpContract(routes.permissions)
  permissions() {
    return ok({ items: this.runtime.authorization.permissions.list() });
  }
}
