import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FileRequestStatus } from './types';

/** 與 `migrations.ts` 的 `file_requests_records` 同一張表；兩份都要寫，表名一致。 */
export const fileRequestRecords = pgTable('file_requests_records', {
  id: uuid('id').primaryKey(),
  ownerActorId: text('owner_actor_id').notNull(),
  ownerName: text('owner_name'),
  title: text('title').notNull(),
  storageObjectId: uuid('storage_object_id').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  status: text('status').$type<FileRequestStatus>().notNull(),
  /** 每次重新處理加一；背景工作帶著它，舊的一次處理結果寫不進新的一次。 */
  generation: integer('generation').notNull().default(1),
  sha256: text('sha256'),
  lineCount: integer('line_count'),
  failureReason: text('failure_reason'),
  reviewNote: text('review_note'),
  reviewedBy: text('reviewed_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type FileRequestRow = typeof fileRequestRecords.$inferSelect;
