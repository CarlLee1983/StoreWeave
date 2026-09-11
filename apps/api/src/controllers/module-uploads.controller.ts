import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Controller, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { moduleResourceNamespace } from '@storeweave/kernel';
import { StorageContentTypeError, StorageLimitError, validateUploadContentType, type StorageObject } from '@storeweave/storage';
import type { JsonSchema7Type } from 'zod-to-json-schema';
import { actorOf, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { ok } from '../http/envelope';
import { RUNTIME, type Runtime } from '../tokens';

const routes = {
  upload: {
    kind: 'direct', request: 'multipart', rateLimit: 'upload',
    input: {
      type: 'object', required: ['module', 'upload'], additionalProperties: { type: 'string' },
      properties: { module: { type: 'string' }, upload: { type: 'string' } },
    },
    output: {
      type: 'object', required: ['success', 'data'], additionalProperties: false,
      properties: { success: { type: 'boolean', const: true }, data: { type: 'object' } },
    },
  },
} as const satisfies Record<string, DirectHttpContract & { input: JsonSchema7Type }>;

type FilePart = { file: Readable & { truncated?: boolean }; filename: string; mimetype: string };
type MultipartRequest = FastifyRequest & AuthenticatedRequest & { file: () => Promise<FilePart | undefined> };

const mimeTypeOf = (declared: string): string => declared.split(';', 1)[0]!.trim().toLowerCase();

/**
 * The one HTTP entrance for files a module declares it accepts (ADR 0050). The command's
 * permission and its input schema are both checked before any byte is read; the bytes
 * then land in the module's private storage scope and never travel through the Command Bus.
 */
@Controller('api/v1/modules')
export class ModuleUploadsController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Post(':module/uploads/:upload')
  @HttpCode(201)
  @HttpContract(routes.upload)
  async upload(
    @Req() request: MultipartRequest, @Param('module') moduleName: string, @Param('upload') uploadName: string,
    @Query() query: Record<string, unknown>,
  ) {
    const mod = this.runtime.modules.find(candidate => candidate.name === moduleName);
    const intake = mod?.uploads?.find(candidate => candidate.name === uploadName);
    if (!mod || !intake) throw PlatformError.notFound('Module upload', `${moduleName}/${uploadName}`);
    const actor = actorOf(request);
    const command = this.runtime.commands.get(intake.command);
    // 以收件 Command 自己的權限把關：寫得進位元組的人，就是執行得了那支 Command 的人，
    // 而且沒有權限的人拿不到 input schema 的驗證細節。
    this.runtime.authorization.assert({ actor, permission: command.descriptor.permission });

    // The object id is ours to assign; a caller-supplied one is exactly the kind of key
    // the strict input exists to refuse, so it is rejected rather than overwritten.
    if (Object.hasOwn(query, 'storageObjectId')) throw PlatformError.validation('storageObjectId is assigned by the upload intake');
    const fields = { ...query };
    const precheck = command.descriptor.input.safeParse({ ...fields, storageObjectId: randomUUID() });
    if (!precheck.success) throw PlatformError.validation(precheck.error.issues[0]?.message ?? 'Invalid upload input', precheck.error.issues);

    const part = await request.file();
    if (!part) throw PlatformError.validation('Exactly one file part is required');
    const contentType = mimeTypeOf(part.mimetype);
    if (!intake.contentTypes.includes(contentType)) {
      part.file.resume();
      throw PlatformError.validation(`Content type ${contentType} is not accepted by upload "${intake.name}"`);
    }

    const scope = this.runtime.storage.forNamespace(moduleResourceNamespace(mod.name));
    let object: StorageObject;
    try {
      object = await scope.upload({
        stream: validateUploadContentType(part.file, contentType), originalName: part.filename, contentType,
        visibility: 'private', ownerActorId: actor.id,
      });
    } catch (error) {
      if (error instanceof StorageLimitError || error instanceof StorageContentTypeError) throw PlatformError.validation(error.message);
      throw error;
    }
    try {
      // Fastify only learns that a file was truncated as the stream ends; a valid prefix is not a success.
      if (part.file.truncated) throw PlatformError.validation(new StorageLimitError(this.runtime.config.storage.maxUploadBytes).message);
      // No idempotency key is forwarded: each request stores new bytes, so a replayed result would
      // describe an earlier object. The module graph rejects intake commands that require one.
      return ok(await this.runtime.commands.execute(intake.command, { ...fields, storageObjectId: object.id }, {
        actor, correlationId: correlationIdOf(request), channel: 'rest',
      }));
    } catch (error) {
      await scope.delete(object.id).catch(cleanupError => this.runtime.logger.warn({
        module: mod.name, upload: intake.name, storageObjectId: object.id,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }, 'module upload compensation failed'));
      throw error;
    }
  }
}
