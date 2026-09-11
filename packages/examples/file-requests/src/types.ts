import { z } from 'zod';

/**
 * 一筆申請的生命週期：送出後排隊，背景處理完成等審核，審核後結束；處理不了就是失敗，
 * 可由有 `file-requests:process` 的人重新排入。只有走完流程的申請會被清理：清理先把它標成
 * `purging`，這個狀態轉不回任何狀態，所以物件刪到一半時不會有人把它重新排入。
 */
export const FILE_REQUEST_STATUSES = ['queued', 'ready_for_review', 'approved', 'rejected', 'failed', 'purging'] as const;
export const fileRequestStatus = z.enum(FILE_REQUEST_STATUSES);
export type FileRequestStatus = z.infer<typeof fileRequestStatus>;
export const TERMINAL_STATUSES: readonly FileRequestStatus[] = ['approved', 'rejected', 'failed'];
/** 還佔著審核人力與儲存空間的申請；每個人同時能有的筆數有上限。 */
export const OPEN_STATUSES: readonly FileRequestStatus[] = ['queued', 'ready_for_review'];

/** 上傳入口與送出 Command 共用同一份清單：入口先擋，Command 再對實際物件核對一次。 */
export const ACCEPTED_CONTENT_TYPES = ['text/plain', 'text/csv'] as const;

export const FILE_REQUEST_PERMISSIONS = {
  submit: 'file-requests:submit',
  review: 'file-requests:review',
  process: 'file-requests:process',
} as const;

const id = z.string().uuid();

export const fileRequestDto = z.object({
  id,
  title: z.string(),
  ownerActorId: z.string(),
  ownerName: z.string().nullable(),
  /** 本模組 storage namespace 裡的私有物件；只有上傳者與審核者讀得到這筆申請。 */
  storageObjectId: id,
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  status: fileRequestStatus,
  generation: z.number().int().positive(),
  sha256: z.string().nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  failureReason: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  submittedAt: z.coerce.date(),
  analyzedAt: z.coerce.date().nullable(),
  decidedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date(),
});
export type FileRequestDto = z.infer<typeof fileRequestDto>;

export const submitFileRequestInput = z.object({
  storageObjectId: id,
  // 標題會進通知信的主旨，換行等控制字元會讓寄信失敗。
  title: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]*$/u, '標題不能包含換行或控制字元'),
}).strict();

export const fileRequestIdInput = z.object({ id }).strict();

export const recordAnalysisInput = z.object({
  id,
  generation: z.number().int().positive(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  lineCount: z.number().int().nonnegative(),
}).strict();

export const recordFailureInput = z.object({
  id,
  generation: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const decideFileRequestInput = z.object({
  id,
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).default(''),
}).strict();

export const purgeFileRequestsInput = z.object({ ids: z.array(id).min(1).max(100) }).strict();
export const purgeFileRequestsOutput = z.object({ deleted: z.array(id) });

export const listMineInput = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const listForReviewInput = z.object({
  status: fileRequestStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const fileRequestListOutput = z.object({ items: z.array(fileRequestDto) });

export const summaryInput = z.object({}).strict();
export const summaryOutput = z.object({
  queued: z.number().int().nonnegative(),
  ready_for_review: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  purging: z.number().int().nonnegative(),
});
export type FileRequestSummary = z.infer<typeof summaryOutput>;

export const claimExpiredInput = z.object({
  olderThan: z.coerce.date(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();
export const claimExpiredOutput = z.object({ items: z.array(z.object({ id, storageObjectId: id })) });
