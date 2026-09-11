import type { z } from 'zod';
import { defineQuery, PlatformError, type Actor, type QueryContext } from '@storeweave/contracts';
import { actorHolds } from '@storeweave/authorization';
import type { CacheScope } from '@storeweave/cache';
import { FileRequestRepository, toFileRequestDto } from './repository';
import {
  FILE_REQUEST_PERMISSIONS, fileRequestDto, fileRequestIdInput, fileRequestListOutput, listForReviewInput, listMineInput, summaryInput, summaryOutput, type FileRequestSummary,
} from './types';

const repository = new FileRequestRepository();
export const SUMMARY_CACHE_KEY = 'summary:v1';
const SUMMARY_TTL_MS = 30_000;

/** 審核者看得到全部；其他人只看得到自己的。範圍在 handler 限縮，頁面與 HTTP 不必各做一次。 */
export function canReview(actor: Actor): boolean {
  return actorHolds(actor, FILE_REQUEST_PERMISSIONS.review);
}

export const getFileRequestQuery = defineQuery({
  name: 'filerequests.request.get',
  summary: '讀取一筆檔案處理申請（非審核者只能讀自己的）',
  input: fileRequestIdInput,
  output: fileRequestDto,
  permission: FILE_REQUEST_PERMISSIONS.submit,
});

export async function getFileRequestHandler(input: z.infer<typeof fileRequestIdInput>, ctx: QueryContext) {
  const row = await repository.find(ctx.db, input.id);
  // 別人的申請回 404 而不是 403：不透露那個 id 存在。
  if (!row || (!canReview(ctx.actor) && row.ownerActorId !== ctx.actor.id)) throw PlatformError.notFound('File request', input.id);
  return toFileRequestDto(row);
}

export const listMyFileRequestsQuery = defineQuery({
  name: 'filerequests.request.listMine',
  summary: '列出自己送出的檔案處理申請',
  input: listMineInput,
  output: fileRequestListOutput,
  permission: FILE_REQUEST_PERMISSIONS.submit,
});

export async function listMyFileRequestsHandler(input: z.infer<typeof listMineInput>, ctx: QueryContext) {
  return { items: (await repository.listByOwner(ctx.db, ctx.actor.id, input.limit)).map(toFileRequestDto) };
}

export const listFileRequestsForReviewQuery = defineQuery({
  name: 'filerequests.request.listForReview',
  summary: '審核佇列',
  input: listForReviewInput,
  output: fileRequestListOutput,
  permission: FILE_REQUEST_PERMISSIONS.review,
});

export async function listFileRequestsForReviewHandler(input: z.infer<typeof listForReviewInput>, ctx: QueryContext) {
  return { items: (await repository.listByStatus(ctx.db, input.status, input.limit)).map(toFileRequestDto) };
}

export const fileRequestSummaryQuery = defineQuery({
  name: 'filerequests.request.summary',
  summary: '各狀態的申請數（快取 30 秒）',
  input: summaryInput,
  output: summaryOutput,
  permission: FILE_REQUEST_PERMISSIONS.review,
});

/**
 * 快取不是事實來源：寫入 Command 會刪掉這個鍵，過期或快取故障時一律回資料庫重算。
 * 快取故障只記 log、不擋查詢——計數錯三十秒可以接受，審核頁打不開不行。
 */
export function createFileRequestSummaryHandler(cache: () => CacheScope) {
  return async (_input: z.infer<typeof summaryInput>, ctx: QueryContext): Promise<FileRequestSummary> => {
    try {
      const cached = await cache().get<FileRequestSummary>(SUMMARY_CACHE_KEY);
      if (cached) return cached;
    } catch (error) {
      ctx.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'file request summary cache read failed');
    }
    const summary = await repository.summary(ctx.db);
    await cache().set(SUMMARY_CACHE_KEY, summary, { ttlMs: SUMMARY_TTL_MS }).catch((error: unknown) => {
      ctx.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'file request summary cache write failed');
    });
    return summary;
  };
}
