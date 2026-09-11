import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { defineCommand, PlatformError, type CommandContext } from '@storeweave/contracts';
import type { CacheScope } from '@storeweave/cache';
import type { NotificationsPort, NotificationTemplate } from '@storeweave/notifications';
import type { StorageScope } from '@storeweave/storage';
import { fileRequestDecidedV1, fileRequestSubmittedV1 } from './events';
import { PROCESS_JOB } from './jobs';
import { SUMMARY_CACHE_KEY } from './queries';
import { FileRequestRepository, toFileRequestDto } from './repository';
import type { FileRequestRow } from './schema';
import { analysisReadyTemplate, decidedTemplate, processingFailedTemplate, reviewNeededTemplate } from './templates';
import {
  ACCEPTED_CONTENT_TYPES, FILE_REQUEST_PERMISSIONS, decideFileRequestInput, fileRequestDto, fileRequestIdInput,
  claimExpiredInput, claimExpiredOutput, purgeFileRequestsInput, purgeFileRequestsOutput, recordAnalysisInput, recordFailureInput, submitFileRequestInput,
} from './types';

export interface FileRequestCommandDeps {
  readonly storage: () => StorageScope;
  readonly cache: () => CacheScope;
  readonly notifications: () => NotificationsPort;
  /** 審核通知信的收件人。沒設定就不寄信；站內通知照常。 */
  readonly reviewerEmail?: string;
  /** 信裡的審核頁連結，由 release 以 `http.publicUrl` 組出來。 */
  readonly reviewUrl: string;
  /** 同一個人同時能有幾筆未結案的申請；上傳入口任何會員都拿得到，這是它的配額。 */
  readonly maxOpenRequestsPerOwner: number;
}

const repository = new FileRequestRepository();
const DECISION_LABELS = { approved: '核准', rejected: '退回' } as const;

/** 去重鍵帶 generation：重新處理是新的一次工作，同一次重送則只排一支。 */
function processJob(requestId: string, generation: number) {
  return { type: PROCESS_JOB, payload: { requestId, generation }, dedupeKey: `file-requests:process:${requestId}:${generation}` };
}

/**
 * 寫入之後讓計數快取失效。它在交易提交前執行，併發查詢可能在提交前把舊值寫回去——
 * 那筆舊值最多活到 TTL（30 秒）。快取不是事實來源，這個窗口是刻意接受的。
 */
async function forgetSummary(deps: FileRequestCommandDeps, ctx: CommandContext): Promise<void> {
  await deps.cache().delete(SUMMARY_CACHE_KEY).catch((error: unknown) => {
    ctx.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'file request summary cache invalidation failed');
  });
}

/** 通知與狀態寫在同一筆交易；`reference` 讓重送的 Command 只通知一次（ADR 0040）。 */
function notifyOwner(
  deps: FileRequestCommandDeps, ctx: CommandContext, row: FileRequestRow,
  template: NotificationTemplate, variables: Record<string, string>, reference: string,
) {
  return deps.notifications().send(ctx.tx, {
    reference, channels: ['inapp'], template, variables,
    recipient: { userId: row.ownerActorId, ...(row.ownerName ? { name: row.ownerName } : {}) },
  }, ctx.enqueue, ctx.now);
}

async function current(ctx: CommandContext, id: string): Promise<FileRequestRow> {
  const row = await repository.find(ctx.tx, id);
  if (!row) throw PlatformError.notFound('File request', id);
  return row;
}

export const submitFileRequestCommand = defineCommand({
  name: 'filerequests.request.submit',
  summary: '以剛上傳的檔案送出處理申請（上傳入口的收件 Command）',
  input: submitFileRequestInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.submit,
  // 上傳入口每次都存新的位元組，所以這支不能要求冪等鍵（ADR 0050）。
  idempotency: 'optional',
  audit: {
    action: 'filerequests.request.submitted', resourceType: 'file-request',
    resourceId: (_input, output) => output.id, redact: input => ({ title: input.title }),
  },
});

export function createSubmitFileRequestHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof submitFileRequestInput>, ctx: CommandContext) => {
    const object = await deps.storage().get(input.storageObjectId);
    // 物件必須是這個 actor 放進本模組 namespace 的：拿別人的物件 id 送申請等於讀別人的檔案。
    if (!object || object.ownerActorId !== ctx.actor.id) throw PlatformError.notFound('Uploaded file', input.storageObjectId);
    if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(object.contentType)) {
      throw PlatformError.validation(`不接受 ${object.contentType} 檔案`);
    }
    if (await repository.findByStorageObject(ctx.tx, object.id)) throw PlatformError.conflict('這個檔案已經送出過申請');
    await repository.lockOwner(ctx.tx, ctx.actor.id);
    if (await repository.countOpenByOwner(ctx.tx, ctx.actor.id) >= deps.maxOpenRequestsPerOwner) {
      // 拒絕之後上傳入口會刪掉剛寫入的物件，所以配額同時限制了留在儲存空間裡的位元組。
      throw PlatformError.conflict(`尚未結案的申請已達上限（${deps.maxOpenRequestsPerOwner} 筆），請等審核完成後再送出`);
    }
    const row = await repository.insert(ctx.tx, {
      id: randomUUID(), ownerActorId: ctx.actor.id, ownerName: ctx.actor.displayName ?? null, title: input.title,
      storageObjectId: object.id, filename: object.originalName, contentType: object.contentType, byteSize: object.byteSize,
      status: 'queued', generation: 1, submittedAt: ctx.now, updatedAt: ctx.now,
    });
    await ctx.enqueue(processJob(row.id, row.generation));
    await ctx.publish({ name: fileRequestSubmittedV1.name, payload: { requestId: row.id, ownerActorId: row.ownerActorId } });
    await forgetSummary(deps, ctx);
    return toFileRequestDto(row);
  };
}

export const recordAnalysisCommand = defineCommand({
  name: 'filerequests.request.recordAnalysis',
  summary: '記錄背景處理結果（背景工作專用）',
  input: recordAnalysisInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.process,
  idempotency: 'optional',
});

export function createRecordAnalysisHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof recordAnalysisInput>, ctx: CommandContext) => {
    const row = await repository.transition(ctx.tx, input.id, { status: 'queued', generation: input.generation }, {
      status: 'ready_for_review', byteSize: input.byteSize, sha256: input.sha256, lineCount: input.lineCount,
      failureReason: null, analyzedAt: ctx.now, updatedAt: ctx.now,
    });
    // 已經不是這一次的 queued：重送或舊的一次處理，回傳現況即可，不再通知。
    if (!row) return toFileRequestDto(await current(ctx, input.id));
    const generationRef = `${row.id}:${row.generation}`;
    await notifyOwner(deps, ctx, row, analysisReadyTemplate, { title: row.title }, `file-requests:analysis-ready:${generationRef}`);
    if (deps.reviewerEmail) {
      await deps.notifications().send(ctx.tx, {
        reference: `file-requests:review-needed:${generationRef}`, channels: ['email'], recipient: { email: deps.reviewerEmail },
        template: reviewNeededTemplate, variables: { title: row.title, reviewUrl: deps.reviewUrl },
      }, ctx.enqueue, ctx.now);
    }
    await forgetSummary(deps, ctx);
    return toFileRequestDto(row);
  };
}

export const recordFailureCommand = defineCommand({
  name: 'filerequests.request.recordFailure',
  summary: '記錄檔案無法處理（背景工作專用）',
  input: recordFailureInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.process,
  idempotency: 'optional',
});

export function createRecordFailureHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof recordFailureInput>, ctx: CommandContext) => {
    const row = await repository.transition(ctx.tx, input.id, { status: 'queued', generation: input.generation }, {
      status: 'failed', failureReason: input.reason, updatedAt: ctx.now,
    });
    if (!row) return toFileRequestDto(await current(ctx, input.id));
    await notifyOwner(deps, ctx, row, processingFailedTemplate, { title: row.title, reason: input.reason },
      `file-requests:processing-failed:${row.id}:${row.generation}`);
    await forgetSummary(deps, ctx);
    return toFileRequestDto(row);
  };
}

export const retryFileRequestCommand = defineCommand({
  name: 'filerequests.request.retry',
  summary: '把處理失敗的申請重新排入處理',
  input: fileRequestIdInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.process,
  idempotency: 'optional',
  audit: { action: 'filerequests.request.retried', resourceType: 'file-request', resourceId: input => input.id },
});

export function createRetryFileRequestHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof fileRequestIdInput>, ctx: CommandContext) => {
    const before = await current(ctx, input.id);
    const row = before.status === 'failed'
      ? await repository.transition(ctx.tx, input.id, { status: 'failed', generation: before.generation }, {
        status: 'queued', generation: before.generation + 1, failureReason: null, updatedAt: ctx.now,
      })
      : undefined;
    if (!row) throw PlatformError.conflict('只有處理失敗的申請可以重新處理');
    await ctx.enqueue(processJob(row.id, row.generation));
    await forgetSummary(deps, ctx);
    return toFileRequestDto(row);
  };
}

export const decideFileRequestCommand = defineCommand({
  name: 'filerequests.request.decide',
  summary: '審核一筆已處理完成的申請',
  input: decideFileRequestInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.review,
  idempotency: 'optional',
  audit: {
    action: 'filerequests.request.decided', resourceType: 'file-request',
    resourceId: input => input.id, redact: input => ({ decision: input.decision }),
  },
});

export function createDecideFileRequestHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof decideFileRequestInput>, ctx: CommandContext) => {
    const row = await repository.transition(ctx.tx, input.id, { status: 'ready_for_review' }, {
      status: input.decision, reviewNote: input.note || null, reviewedBy: ctx.actor.id, decidedAt: ctx.now, updatedAt: ctx.now,
    });
    if (!row) {
      await current(ctx, input.id);
      throw PlatformError.conflict('這筆申請目前不能審核');
    }
    await ctx.publish({ name: fileRequestDecidedV1.name, payload: { requestId: row.id, decision: input.decision } });
    await notifyOwner(deps, ctx, row, decidedTemplate, {
      title: row.title, decision: DECISION_LABELS[input.decision], note: input.note ? `備註：${input.note}` : '',
    }, `file-requests:decided:${row.id}`);
    await forgetSummary(deps, ctx);
    return toFileRequestDto(row);
  };
}

export const claimExpiredFileRequestsCommand = defineCommand({
  name: 'filerequests.request.claimExpired',
  summary: '把超過保留期的已結束申請標成清理中並交出（清理工作專用）',
  input: claimExpiredInput,
  output: claimExpiredOutput,
  permission: FILE_REQUEST_PERMISSIONS.process,
  idempotency: 'optional',
});

export function createClaimExpiredFileRequestsHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof claimExpiredInput>, ctx: CommandContext) => {
    const items = await repository.claimExpired(ctx.tx, input.olderThan, input.limit);
    if (items.length > 0) await forgetSummary(deps, ctx);
    return { items };
  };
}

export const purgeFileRequestsCommand = defineCommand({
  name: 'filerequests.request.purge',
  summary: '刪除已清掉物件的申請紀錄（清理工作專用）',
  input: purgeFileRequestsInput,
  output: purgeFileRequestsOutput,
  permission: FILE_REQUEST_PERMISSIONS.process,
  idempotency: 'optional',
  audit: { action: 'filerequests.request.purged', resourceType: 'file-request', redact: input => ({ count: input.ids.length }) },
});

export function createPurgeFileRequestsHandler(deps: FileRequestCommandDeps) {
  return async (input: z.infer<typeof purgeFileRequestsInput>, ctx: CommandContext) => {
    const deleted = await repository.deletePurging(ctx.tx, input.ids);
    if (deleted.length > 0) await forgetSummary(deps, ctx);
    return { deleted };
  };
}
