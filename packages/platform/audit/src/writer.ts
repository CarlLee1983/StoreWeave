import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Actor, AuditEntryInput, DrizzleDb, Tx } from '@storeweave/contracts';
import { platformSchema } from '@storeweave/db';
import { redact } from './redact';

export interface AuditRecord {
  id: string;
  occurredAt: Date;
  actorId: string;
  actorType: string;
  extensionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  correlationId: string;
  payload: unknown;
}

export class AuditWriter {
  /** 寫入 audit log。務必與業務寫入使用同一個 tx，才不會出現「做了但沒紀錄」。 */
  async write(
    tx: Tx,
    input: AuditEntryInput & { actor: Actor; correlationId: string },
  ): Promise<void> {
    await tx.insert(platformSchema.auditLog).values({
      id: randomUUID(),
      actorId: input.actor.id,
      actorType: input.actor.type,
      extensionId: input.actor.extensionId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      correlationId: input.correlationId,
      payload: input.payload ? (redact(input.payload) as Record<string, unknown>) : null,
    });
  }

  async list(
    db: DrizzleDb,
    filter: { resourceType?: string; resourceId?: string; limit?: number } = {},
  ): Promise<AuditRecord[]> {
    const conditions = [];
    if (filter.resourceType) conditions.push(eq(platformSchema.auditLog.resourceType, filter.resourceType));
    if (filter.resourceId) conditions.push(eq(platformSchema.auditLog.resourceId, filter.resourceId));
    const rows = await db
      .select()
      .from(platformSchema.auditLog)
      .where(conditions.length ? and(...conditions) : sql`true`)
      .orderBy(desc(platformSchema.auditLog.occurredAt))
      .limit(filter.limit ?? 50);
    return rows as unknown as AuditRecord[];
  }
}
