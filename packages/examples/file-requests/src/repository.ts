import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { fileRequestRecords, type FileRequestRow } from './schema';
import { FILE_REQUEST_STATUSES, OPEN_STATUSES, type FileRequestDto, type FileRequestStatus, type FileRequestSummary } from './types';

export function toFileRequestDto(row: FileRequestRow): FileRequestDto {
  return {
    id: row.id, title: row.title, ownerActorId: row.ownerActorId, ownerName: row.ownerName, storageObjectId: row.storageObjectId,
    filename: row.filename, contentType: row.contentType, byteSize: row.byteSize, status: row.status,
    generation: row.generation, sha256: row.sha256, lineCount: row.lineCount, failureReason: row.failureReason,
    reviewNote: row.reviewNote, reviewedBy: row.reviewedBy, submittedAt: row.submittedAt,
    analyzedAt: row.analyzedAt, decidedAt: row.decidedAt, updatedAt: row.updatedAt,
  };
}

/**
 * 狀態轉換一律是帶條件的 UPDATE：「只有還在 queued、而且是同一次處理」才寫得進去。
 * 背景工作重送、兩個 worker 搶同一筆，都因此只有一次生效，不需要先讀再鎖。
 */
export class FileRequestRepository {
  async insert(tx: Tx, values: typeof fileRequestRecords.$inferInsert): Promise<FileRequestRow> {
    const [row] = await tx.insert(fileRequestRecords).values(values).returning();
    return row!;
  }

  async find(db: DrizzleDb | Tx, id: string): Promise<FileRequestRow | undefined> {
    const [row] = await db.select().from(fileRequestRecords).where(eq(fileRequestRecords.id, id)).limit(1);
    return row;
  }

  async findByStorageObject(db: DrizzleDb | Tx, storageObjectId: string): Promise<FileRequestRow | undefined> {
    const [row] = await db.select().from(fileRequestRecords).where(eq(fileRequestRecords.storageObjectId, storageObjectId)).limit(1);
    return row;
  }

  async transition(
    tx: Tx, id: string, from: { status: FileRequestStatus; generation?: number },
    patch: Partial<typeof fileRequestRecords.$inferInsert>,
  ): Promise<FileRequestRow | undefined> {
    const [row] = await tx.update(fileRequestRecords).set(patch).where(and(
      eq(fileRequestRecords.id, id),
      eq(fileRequestRecords.status, from.status),
      ...(from.generation === undefined ? [] : [eq(fileRequestRecords.generation, from.generation)]),
    )).returning();
    return row;
  }

  async listByOwner(db: DrizzleDb | Tx, ownerActorId: string, limit: number): Promise<FileRequestRow[]> {
    return db.select().from(fileRequestRecords).where(eq(fileRequestRecords.ownerActorId, ownerActorId))
      .orderBy(desc(fileRequestRecords.submittedAt)).limit(limit);
  }

  async listByStatus(db: DrizzleDb | Tx, status: FileRequestStatus | undefined, limit: number): Promise<FileRequestRow[]> {
    return db.select().from(fileRequestRecords)
      .where(status ? eq(fileRequestRecords.status, status) : undefined)
      .orderBy(asc(fileRequestRecords.submittedAt)).limit(limit);
  }

  async summary(db: DrizzleDb | Tx): Promise<FileRequestSummary> {
    const rows = await db.select({ status: fileRequestRecords.status, count: sql<number>`count(*)::int` })
      .from(fileRequestRecords).groupBy(fileRequestRecords.status);
    const counts = Object.fromEntries(FILE_REQUEST_STATUSES.map(status => [status, 0])) as FileRequestSummary;
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** 同一個人的送出彼此排隊，未結案筆數的上限因此不會被併發請求穿過。 */
  async lockOwner(tx: Tx, ownerActorId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`file-requests:owner:${ownerActorId}`}, 0))`);
  }

  async countOpenByOwner(db: DrizzleDb | Tx, ownerActorId: string): Promise<number> {
    const [row] = await db.select({ value: count() }).from(fileRequestRecords)
      .where(and(eq(fileRequestRecords.ownerActorId, ownerActorId), inArray(fileRequestRecords.status, [...OPEN_STATUSES])));
    return Number(row?.value ?? 0);
  }

  /**
   * 把超過保留期的已結束申請標成 `purging` 交給清理，連同上次沒清完的 `purging` 一起。
   * 標記與「重新處理」互斥：`failed` 一旦變成 `purging`，重新處理的條件轉換就不成立。
   */
  async claimExpired(tx: Tx, olderThan: Date, limit: number): Promise<{ id: string; storageObjectId: string }[]> {
    const result = await tx.execute<{ id: string; storage_object_id: string }>(sql`
      UPDATE public.file_requests_records SET status = 'purging'
      WHERE id IN (
        SELECT id FROM public.file_requests_records
        WHERE status = 'purging' OR (status IN ('approved', 'rejected', 'failed') AND updated_at < ${olderThan})
        ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, storage_object_id`);
    return result.rows.map(row => ({ id: row.id, storageObjectId: row.storage_object_id }));
  }

  async deletePurging(tx: Tx, ids: readonly string[]): Promise<string[]> {
    const rows = await tx.delete(fileRequestRecords)
      .where(and(inArray(fileRequestRecords.id, [...ids]), eq(fileRequestRecords.status, 'purging')))
      .returning({ id: fileRequestRecords.id });
    return rows.map(row => row.id);
  }
}
