import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { DEFAULT_JOB_MAX_ATTEMPTS, type JobContext, type JobHandler } from '@storeweave/jobs';
import type { StorageScope } from '@storeweave/storage';
import type { FileRequestDto } from './types';

export const PROCESS_JOB = 'filerequests.process';
export const CLEANUP_JOB = 'filerequests.cleanup';

/** 每種 job 的 payload 都有版本化 schema；改形狀時保留舊版並提高 currentVersion。 */
export const processJobPayload = z.object({ requestId: z.string().uuid(), generation: z.number().int().positive() }).strict();
/** cron 排程產生的 payload 形狀（見 skill 第 7 步）。 */
export const cleanupJobPayload = z.object({ scheduledFor: z.string().datetime() }).strict();

export interface FileAnalysis {
  readonly byteSize: number;
  readonly sha256: string;
  readonly lineCount: number;
}

/** 可替換的處理步驟：測試用它模擬暫時性故障，真實模組可以換成自己的處理。 */
export type FileAnalyzer = (content: Readable, signal: AbortSignal) => Promise<FileAnalysis>;

/** 內容本身不可處理——重試也不會好，因此記成失敗，而不是讓 worker 一直重送。 */
export class UnprocessableFileError extends Error {
  override readonly name = 'UnprocessableFileError';
}

export const analyzeText: FileAnalyzer = async (content, signal) => {
  const hash = createHash('sha256');
  let byteSize = 0;
  let lineCount = 0;
  let lastByte = -1;
  for await (const chunk of content) {
    if (signal.aborted) {
      content.destroy();
      throw signal.reason ?? new Error('File analysis was aborted');
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    // 上傳入口對文字格式不做內容嗅探（B09 只認得幾種二進位開頭），這一步才判斷它是不是純文字。
    if (bytes.includes(0)) throw new UnprocessableFileError('檔案不是純文字');
    hash.update(bytes);
    byteSize += bytes.length;
    for (const byte of bytes) if (byte === 0x0a) lineCount += 1;
    if (bytes.length > 0) lastByte = bytes[bytes.length - 1]!;
  }
  if (byteSize === 0) throw new UnprocessableFileError('檔案是空的');
  if (lastByte !== 0x0a) lineCount += 1;
  return { byteSize, sha256: hash.digest('hex'), lineCount };
};

function bus(ctx: JobContext) {
  if (!ctx.executeCommand || !ctx.executeQuery) throw new Error('File request jobs need the core job command and query bridge');
  return { command: ctx.executeCommand, query: ctx.executeQuery };
}

/**
 * 背景處理。Job 沒有資料庫握柄：讀申請走 Query、寫結果走 Command，位元組從模組自己的 storage scope 讀。
 * 冪等來自兩層：Command 用 `ctx.idempotencyKey`，狀態轉換要求「還在 queued、同一個 generation」。
 * 最後一次嘗試仍失敗就記成失敗而不是拋錯：進了死信的工作不會改變申請狀態，申請會永遠卡在排隊中。
 */
export function createProcessJob(deps: { readonly storage: () => StorageScope; readonly analyze: FileAnalyzer }): JobHandler {
  return async (payload, ctx) => {
    const { requestId, generation } = processJobPayload.parse(payload);
    const { command, query } = bus(ctx);
    const request = await query('filerequests.request.get', { id: requestId }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'NOT_FOUND') return undefined;
      throw error;
    }) as FileRequestDto | undefined;
    if (!request || request.status !== 'queued' || request.generation !== generation) return;

    const fail = (reason: string) => command('filerequests.request.recordFailure', { id: requestId, generation, reason }, `${ctx.idempotencyKey}:failure`);
    const object = await deps.storage().get(request.storageObjectId);
    if (!object) {
      await fail('找不到上傳的檔案');
      return;
    }
    let analysis: FileAnalysis;
    try {
      const opened = await deps.storage().open(object.id);
      try {
        analysis = await deps.analyze(opened.content.stream, ctx.signal);
      } finally {
        opened.content.stream.destroy();
      }
    } catch (error) {
      if (error instanceof UnprocessableFileError) {
        await fail(error.message);
        return;
      }
      // 暫時性故障（儲存體、逾時、取消）交給 worker 重試；用完嘗試次數就記成失敗，讓人可以重新處理。
      if (ctx.attempt >= DEFAULT_JOB_MAX_ATTEMPTS && !ctx.signal.aborted) {
        await fail(`處理 ${ctx.attempt} 次仍失敗：${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        return;
      }
      throw error;
    }
    await command('filerequests.request.recordAnalysis', { id: requestId, generation, ...analysis }, ctx.idempotencyKey);
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;
const CLEANUP_MAX_ROUNDS = 50;

/**
 * 排程清理。目標明確：只動本模組的表裡已走完流程、而且超過保留期的申請。
 * 每一批先在 Command 裡標成 `purging`（之後就不能被重新處理），再刪本模組 namespace 裡的物件，最後刪列。
 * 中途失敗重跑是安全的：`purging` 的列會被下一次再交出來，物件已刪時 delete 是 no-op。
 */
export function createCleanupJob(deps: { readonly storage: () => StorageScope; readonly retentionDays: number }): JobHandler {
  return async (payload, ctx) => {
    const { scheduledFor } = cleanupJobPayload.parse(payload);
    const { command } = bus(ctx);
    const olderThan = new Date(Date.parse(scheduledFor) - deps.retentionDays * DAY_MS).toISOString();
    for (let round = 0; round < CLEANUP_MAX_ROUNDS && !ctx.signal.aborted; round += 1) {
      const { items } = await command('filerequests.request.claimExpired', { olderThan, limit: CLEANUP_BATCH },
        `${ctx.idempotencyKey}:claim:${round}`) as { items: { id: string; storageObjectId: string }[] };
      if (items.length === 0) return;
      for (const item of items) await deps.storage().delete(item.storageObjectId);
      const ids = items.map(item => item.id).sort();
      // 冪等鍵由這一批的內容決定，重試時才不會重播到另一批的結果。
      const batchKey = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 32);
      await command('filerequests.request.purge', { ids }, `${ctx.idempotencyKey}:purge:${batchKey}`);
      if (items.length < CLEANUP_BATCH) return;
    }
  };
}
