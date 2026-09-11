import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { StorageLimitError } from '@storeweave/storage';
import { actorOf, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { ok } from '../http/envelope';
import { RUNTIME, type Runtime } from '../tokens';

const uuid = { type: 'string', format: 'uuid' } as const;
const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
const asset = {
  type: 'object', required: ['id', 'altText', 'status', 'generation', 'width', 'height', 'processingError', 'createdAt', 'updatedAt'], additionalProperties: false,
  properties: {
    id: uuid, altText: { type: 'string' }, status: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] }, generation: { type: 'integer', minimum: 1 },
    width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] }, processingError: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;
const response = (data: object) => ({ type: 'object', required: ['success', 'data'], additionalProperties: false,
  properties: { success: { type: 'boolean', const: true }, data } } as const);
const routes = {
  upload: { kind: 'direct', request: 'multipart', input: empty, output: response(asset) },
  list: { kind: 'direct', request: 'none', input: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false }, output: response({ type: 'object', required: ['items', 'total'], additionalProperties: false, properties: { items: { type: 'array', items: asset }, total: { type: 'integer', minimum: 0 } } }) },
  get: { kind: 'direct', request: 'none', input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: response(asset) },
  updateAlt: { kind: 'direct', request: 'body', input: { type: 'object', properties: { altText: { type: 'string', maxLength: 500 } }, required: ['altText'], additionalProperties: false }, output: response(asset) },
  retry: { kind: 'direct', request: 'none', input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: response(asset) },
  remove: { kind: 'direct', request: 'none', input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: response(empty) },
  preview: { kind: 'direct', request: 'none', input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: 'binary' },
} as const satisfies Record<string, DirectHttpContract>;

type MultipartRequest = FastifyRequest & AuthenticatedRequest & { file: () => Promise<{ file: NodeJS.ReadableStream; filename: string; mimetype: string } | undefined> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseId(id: string): string { if (!UUID.test(id)) throw PlatformError.notFound('Media asset', id); return id; }
function json(value: Awaited<ReturnType<Runtime['media']['get']>>) {
  if (!value) throw PlatformError.notFound('Media asset', 'unknown');
  return { id: value.id, altText: value.altText, status: value.status, generation: value.generation, width: value.width,
    height: value.height, processingError: value.processingError, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}

/** Media policy is distinct from generic storage and never exposes its storage namespace. */
@Controller('api/v1/media')
export class MediaController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  private assert(request: AuthenticatedRequest, permission: string): void { this.runtime.authorization.assert({ actor: actorOf(request), permission }); }

  @Post()
  @HttpCode(202)
  @HttpContract(routes.upload)
  async upload(@Req() request: MultipartRequest) {
    this.assert(request, 'media:write');
    const part = await request.file();
    if (!part) throw PlatformError.validation('Exactly one file part is required');
    try {
      const created = await this.runtime.media.upload({ stream: part.file as import('node:stream').Readable, originalName: part.filename, contentType: part.mimetype, ownerActorId: actorOf(request).id });
      if ((part.file as NodeJS.ReadableStream & { truncated?: boolean }).truncated) {
        await this.runtime.media.remove(created.id);
        throw new StorageLimitError(this.runtime.config.storage.maxUploadBytes);
      }
      return ok(json(created));
    } catch (error) {
      if (error instanceof StorageLimitError) throw PlatformError.validation(error.message);
      throw error;
    }
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    this.assert(request, 'media:read');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw PlatformError.validation('Invalid media pagination');
    const result = await this.runtime.media.list({ limit, offset });
    return ok({ items: result.items.map(json), total: result.total });
  }

  @Get(':id')
  @HttpContract(routes.get)
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) { this.assert(request, 'media:read'); return ok(json(await this.runtime.media.get(parseId(id)))); }

  @Patch(':id')
  @HttpContract(routes.updateAlt)
  async updateAlt(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { altText?: unknown }) {
    this.assert(request, 'media:write');
    if (typeof body?.altText !== 'string') throw PlatformError.validation('altText is required');
    return ok(json(await this.runtime.media.updateAltText(parseId(id), body.altText)));
  }

  @Post(':id/retry')
  @HttpCode(202)
  @HttpContract(routes.retry)
  async retry(@Req() request: AuthenticatedRequest, @Param('id') id: string) { this.assert(request, 'media:write'); return ok(json(await this.runtime.media.retry(parseId(id)))); }

  @Delete(':id')
  @HttpContract(routes.remove)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) { this.assert(request, 'media:delete'); await this.runtime.media.remove(parseId(id)); return ok({}); }

  @Get(':id/preview')
  @HttpContract(routes.preview)
  async preview(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply, @Param('id') id: string) {
    this.assert(request, 'media:read');
    const opened = await this.runtime.media.openPreview(parseId(id));
    reply.header('content-type', opened.object.contentType);
    reply.header('content-length', String(opened.object.byteSize));
    reply.header('content-disposition', 'inline');
    reply.header('cache-control', 'private, no-store');
    (request as FastifyRequest).raw.once('close', () => opened.content.destroy());
    return reply.send(opened.content);
  }
}
