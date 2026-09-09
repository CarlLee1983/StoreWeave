import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { StorageContentTypeError, StorageLimitError, validateUploadContentType, type StorageObject, type StorageScope } from '@storeweave/storage';
import { requireKeyring } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';
import { actorOf, Public, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type StorageHttpContract } from '../http/contract';
import { ok } from '../http/envelope';
import { RUNTIME, type Runtime } from '../tokens';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema7Type;
const uuid = { type: 'string', format: 'uuid' } as const satisfies JsonSchema7Type;
const response = (data: JsonSchema7Type) => ({
  type: 'object', required: ['success', 'data'], additionalProperties: false,
  properties: { success: { type: 'boolean', const: true }, data },
} satisfies JsonSchema7Type);
const objectData = {
  type: 'object', required: ['id', 'visibility', 'filename', 'contentType', 'byteSize', 'sha256', 'createdAt'], additionalProperties: false,
  properties: {
    id: uuid, visibility: { type: 'string', enum: ['private', 'public'] }, filename: { type: 'string' }, contentType: { type: 'string' },
    byteSize: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, createdAt: { type: 'string', format: 'date-time' },
  },
} as const satisfies JsonSchema7Type;
const idParams = { id: 'id' } as const;
const routes = {
  upload: { kind: 'storage', operation: 'upload', request: 'multipart', input: {
    type: 'object', properties: { visibility: { type: 'string', enum: ['private', 'public'] } }, additionalProperties: false,
  }, output: response(objectData) },
  list: { kind: 'storage', operation: 'list', request: 'none', input: {
    type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false,
  }, output: response({ type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: objectData }, nextCursor: { type: 'string' } } }) },
  metadata: { kind: 'storage', operation: 'metadata', request: 'none', params: idParams, input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: response(objectData) },
  content: { kind: 'storage', operation: 'content', request: 'none', params: idParams, input: { type: 'object', properties: { id: uuid, token: { type: 'string' } }, required: ['id'], additionalProperties: false }, output: 'binary' },
  signedUrl: { kind: 'storage', operation: 'signed-url', request: 'body', params: idParams, input: {
    type: 'object', properties: { id: uuid, expiresInSeconds: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false,
  }, output: response({ type: 'object', required: ['url', 'expiresAt'], additionalProperties: false, properties: { url: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' } } }) },
  delete: { kind: 'storage', operation: 'delete', request: 'none', params: idParams, input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false }, output: response(emptyInput) },
} as const satisfies Record<string, StorageHttpContract>;

type MultipartRequest = FastifyRequest & AuthenticatedRequest & { file: () => Promise<{ file: NodeJS.ReadableStream; filename: string; mimetype: string; truncated: boolean } | undefined> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectJson(object: StorageObject) {
  return {
    id: object.id, visibility: object.visibility, filename: object.originalName, contentType: object.contentType,
    byteSize: object.byteSize, sha256: object.sha256, createdAt: object.createdAt.toISOString(),
  };
}

function parseId(id: string): string {
  if (!UUID.test(id)) throw PlatformError.notFound('Storage object', id);
  return id;
}

function parseCursor(value: unknown): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) throw PlatformError.validation('Invalid storage cursor');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    const createdAt = typeof decoded.createdAt === 'string' ? new Date(decoded.createdAt) : undefined;
    if (!createdAt || Number.isNaN(createdAt.valueOf()) || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) throw new Error('invalid');
    return { createdAt, id: decoded.id };
  } catch { throw PlatformError.validation('Invalid storage cursor'); }
}

function cursorFor(object: ReturnType<typeof objectJson>): string {
  return Buffer.from(JSON.stringify({ createdAt: object.createdAt, id: object.id })).toString('base64url');
}

/** Generic storage is operator/service-only. B10 owns catalog/customer media policy. */
@Controller('api/v1/storage/objects')
export class StorageController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  private scope() { return this.runtime.storage.forNamespace('platform-storage'); }
  private assert(request: AuthenticatedRequest, permission: string): void {
    this.runtime.authorization.assert({ actor: actorOf(request), permission });
  }
  private async object(id: string) {
    const object = await this.scope().get(parseId(id));
    if (!object) throw PlatformError.notFound('Storage object', id);
    return object;
  }

  @Post()
  @HttpCode(201)
  @HttpContract(routes.upload)
  async upload(@Req() request: MultipartRequest, @Query('visibility') rawVisibility?: string) {
    this.assert(request, 'storage:write');
    const visibility = rawVisibility ?? 'private';
    if (visibility !== 'private' && visibility !== 'public') throw PlatformError.validation('visibility must be private or public');
    if (visibility === 'public') this.assert(request, 'storage:publish');
    const part = await request.file();
    if (!part) throw PlatformError.validation('Exactly one file part is required');
    if ((part.file as NodeJS.ReadableStream & { truncated?: boolean }).truncated) {
      throw PlatformError.validation(`Upload exceeds the ${this.runtime.config.storage.maxUploadBytes}-byte storage limit`);
    }
    try {
      const object = await this.scope().upload({
        stream: validateUploadContentType(part.file as import('node:stream').Readable, part.mimetype),
        originalName: part.filename, contentType: part.mimetype, visibility, ownerActorId: actorOf(request).id,
      });
      // Fastify discovers `truncated` only as the stream ends. Do not report
      // success for a valid prefix; compensate the just-created object first.
      if ((part.file as NodeJS.ReadableStream & { truncated?: boolean }).truncated) {
        await this.scope().delete(object.id);
        throw new StorageLimitError(this.runtime.config.storage.maxUploadBytes);
      }
      return ok(objectJson(object));
    } catch (error) {
      if (error instanceof StorageLimitError || error instanceof StorageContentTypeError) throw PlatformError.validation(error.message);
      throw error;
    }
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    this.assert(request, 'storage:read');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw PlatformError.validation('limit must be an integer between 1 and 100');
    const items = await this.scope().list({ limit, cursor: parseCursor(query.cursor) });
    const serialized = items.map(objectJson);
    return ok({ items: serialized, ...(serialized.length === limit ? { nextCursor: cursorFor(serialized.at(-1)!) } : {}) });
  }

  @Get(':id')
  @HttpContract(routes.metadata)
  async metadata(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    this.assert(request, 'storage:read');
    return ok(objectJson(await this.object(id)));
  }

  @Get(':id/content')
  @Public()
  @HttpContract(routes.content)
  async content(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply, @Param('id') id: string, @Query('token') token?: string) {
    const parsedId = parseId(id);
    let opened: Awaited<ReturnType<StorageScope['open']>>;
    if (token) {
      try {
        opened = await this.scope().openSignedDownload(token, requireKeyring(this.runtime, 'storage-download'), new Date());
      } catch { throw PlatformError.notFound('Storage object', id); }
      if (opened.object.id !== parsedId) throw PlatformError.notFound('Storage object', id);
    } else {
      const object = await this.object(parsedId);
      if (object.visibility !== 'public') this.assert(request, 'storage:read');
      opened = await this.scope().open(parsedId);
    }
    const filename = encodeURIComponent(opened.object.originalName).replace(/%20/g, '+');
    reply.header('content-type', opened.object.contentType);
    reply.header('content-length', String(opened.object.byteSize));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${filename}`);
    reply.header('etag', `"${opened.object.sha256}"`);
    reply.header('cache-control', opened.object.visibility === 'public' && !token ? 'public, max-age=300' : 'private, no-store');
    (request as FastifyRequest).raw.once('close', () => opened.content.stream.destroy());
    return reply.send(opened.content.stream);
  }

  @Post(':id/download-url')
  @HttpContract(routes.signedUrl)
  async issueSignedUrl(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { expiresInSeconds?: unknown }) {
    this.assert(request, 'storage:share');
    const seconds = body?.expiresInSeconds === undefined ? this.runtime.config.storage.signedUrlTtlSeconds : Number(body.expiresInSeconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > this.runtime.config.storage.signedUrlTtlSeconds) {
      throw PlatformError.validation(`expiresInSeconds must be between 1 and ${this.runtime.config.storage.signedUrlTtlSeconds}`);
    }
    const expiresAt = new Date(Date.now() + seconds * 1000);
    const signed = await this.scope().issueSignedDownload(parseId(id), requireKeyring(this.runtime, 'storage-download'), expiresAt);
    const base = new URL(`/api/v1/storage/objects/${id}/content`, this.runtime.config.http.publicUrl);
    base.searchParams.set('token', signed.urlToken);
    return ok({ url: base.toString(), expiresAt: signed.expiresAt.toISOString() });
  }

  @Delete(':id')
  @HttpCode(200)
  @HttpContract(routes.delete)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    this.assert(request, 'storage:delete');
    await this.scope().delete(parseId(id));
    return ok({});
  }
}
