import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, formValue, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import { canReview } from './queries';
import { ACCEPTED_CONTENT_TYPES, type FileRequestDto, type FileRequestSummary } from './types';

/** 通用上傳入口（ADR 0050）上屬於本模組的那一條。 */
export const FILE_REQUEST_UPLOAD_PATH = '/api/v1/modules/file-requests/uploads/request-file';

export interface FileRequestListView {
  requests: FileRequestDto[];
  canReview: boolean;
  uploadPath: string;
  acceptedTypes: readonly string[];
}

export interface FileRequestDetailView {
  request: FileRequestDto;
  canReview: boolean;
}

/** 審核頁與它的兩個寫入頁共用：寫入失敗時重新渲染的就是同一張審核頁。 */
export interface FileRequestReviewView {
  summary: FileRequestSummary;
  requests: FileRequestDto[];
  error?: string;
}

type Responses = StorefrontHttpContract['responses'];
const html = (status: number | 'platform-error') =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' }) as const;
const viewResponses: Responses = [html(200), html(404), html('platform-error')];
const writeResponses: Responses = [
  { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/file-requests/review' } }, html(400), html('platform-error'),
];
const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { id: 'id' } as const;

/**
 * 審核頁只列需要有人動手的申請：待審核與處理失敗分開查。不篩狀態地取前 N 筆，
 * 保留期內累積的結案資料會把待處理的擠出頁面。
 */
async function reviewView(ctx: PageResolveContext, error?: string): Promise<FileRequestReviewView> {
  const list = (status: 'ready_for_review' | 'failed') =>
    ctx.queries.execute<{ items: FileRequestDto[] }>('filerequests.request.listForReview', { status }, { actor: ctx.actor });
  const [summary, pending, failed] = await Promise.all([
    ctx.queries.execute<FileRequestSummary>('filerequests.request.summary', {}, { actor: ctx.actor }),
    list('ready_for_review'), list('failed'),
  ]);
  return { summary, requests: [...pending.items, ...failed.items], ...(error ? { error } : {}) };
}

/** 業務上的拒絕（狀態不對、輸入不合）重畫審核頁；權限不足等其他錯誤交給錯誤頁。 */
async function writeOrRerender(
  ctx: PageResolveContext, command: string, input: unknown,
): Promise<PageOutcome<FileRequestReviewView>> {
  try {
    await ctx.commands.execute(command, input, { actor: ctx.actor, correlationId: randomUUID() });
    return { kind: 'redirect', location: '/file-requests/review' };
  } catch (error) {
    if (error instanceof PlatformError && (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) {
      return { kind: 'view', status: 400, view: await reviewView(ctx, error.message) };
    }
    throw error;
  }
}

/**
 * 頁面只是呼叫端：權限在 Query／Command 檢查，範圍在 handler 依 actor 限縮。
 * `audience: 'operator'` 在 base release 裡涵蓋會員與後台帳號（兩者都是 `user`），
 * 所以同一組頁面同時是前台的「我的申請」與後台的審核頁（ADR 0050）。
 */
export const fileRequestPages = {
  index: definePage({
    id: 'filerequests.request.index',
    path: '/file-requests',
    method: 'get',
    audience: 'operator',
    input: z.object({}),
    contract: { kind: 'storefront', request: 'none', input: { type: 'object', properties: {}, additionalProperties: false }, responses: viewResponses },
    resolve: async (ctx): Promise<PageOutcome<FileRequestListView>> => {
      const mine = await ctx.queries.execute<{ items: FileRequestDto[] }>('filerequests.request.listMine', {}, { actor: ctx.actor });
      return { kind: 'view', view: {
        requests: mine.items, canReview: canReview(ctx.actor), uploadPath: FILE_REQUEST_UPLOAD_PATH, acceptedTypes: ACCEPTED_CONTENT_TYPES,
      } };
    },
  }),
  review: definePage({
    id: 'filerequests.review.index',
    path: '/file-requests/review',
    method: 'get',
    audience: 'operator',
    input: z.object({}),
    contract: { kind: 'storefront', request: 'none', input: { type: 'object', properties: {}, additionalProperties: false }, responses: viewResponses },
    resolve: async (ctx): Promise<PageOutcome<FileRequestReviewView>> => ({ kind: 'view', view: await reviewView(ctx) }),
  }),
  view: definePage({
    id: 'filerequests.request.view',
    path: '/file-requests/:id',
    method: 'get',
    audience: 'operator',
    input: z.object({ id: z.string().uuid() }),
    contract: {
      kind: 'storefront', request: 'none', params: idParams, responses: viewResponses,
      input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false },
    },
    resolve: async (ctx, input): Promise<PageOutcome<FileRequestDetailView>> => {
      try {
        const request = await ctx.queries.execute<FileRequestDto>('filerequests.request.get', { id: input.id }, { actor: ctx.actor });
        return { kind: 'view', view: { request, canReview: canReview(ctx.actor) } };
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'NOT_FOUND') return { kind: 'not-found' };
        throw error;
      }
    },
  }),
  decide: definePage({
    id: 'filerequests.review.decide',
    path: '/file-requests/review/:id/decision',
    method: 'post',
    audience: 'operator',
    input: z.object({ id: z.string().uuid(), decision: formValue.pipe(z.enum(['approved', 'rejected'])), note: formValue.optional() }),
    contract: {
      kind: 'storefront', request: 'form', params: idParams, responses: writeResponses,
      input: {
        type: 'object', required: ['id', 'decision'], additionalProperties: false,
        properties: { id: uuid, decision: { type: 'string', enum: ['approved', 'rejected'] }, note: { type: 'string', maxLength: 500 }, _csrf: { type: 'string' } },
      },
    },
    loginNext: () => '/file-requests/review',
    resolve: (ctx, input) => writeOrRerender(ctx, 'filerequests.request.decide', { id: input.id, decision: input.decision, note: input.note ?? '' }),
  }),
  retry: definePage({
    id: 'filerequests.review.retry',
    path: '/file-requests/review/:id/retry',
    method: 'post',
    audience: 'operator',
    input: z.object({ id: z.string().uuid() }),
    contract: {
      kind: 'storefront', request: 'form', params: idParams, responses: writeResponses,
      input: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: uuid, _csrf: { type: 'string' } } },
    },
    loginNext: () => '/file-requests/review',
    resolve: (ctx, input) => writeOrRerender(ctx, 'filerequests.request.retry', { id: input.id }),
  }),
} as const;

export type FileRequestPages = typeof fileRequestPages;
