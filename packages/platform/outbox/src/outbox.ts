import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DomainEvent, DrizzleDb, Tx } from '@storeweave/contracts';
import { platformSchema } from '@storeweave/db';

export interface OutboxRow {
  [key: string]: unknown;
  id: string;
  event_name: string;
  event_version: number;
  payload: unknown;
  actor_id: string;
  correlation_id: string;
  occurred_at: Date;
  attempts: number;
}

export interface AppendInput {
  name: string;
  version: number;
  payload: unknown;
  actorId: string;
  correlationId: string;
  occurredAt?: Date;
}

/**
 * Transactional Outbox。
 * `append` 必須在業務寫入的同一個交易內呼叫 —— 這是「事件不會遺失也不會多發」的唯一保證點。
 */
export class OutboxStore {
  async append(tx: Tx, input: AppendInput): Promise<string> {
    const id = randomUUID();
    await tx.insert(platformSchema.outbox).values({
      id,
      eventName: input.name,
      eventVersion: input.version,
      payload: input.payload as Record<string, unknown>,
      actorId: input.actorId,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt ?? new Date(),
    });
    return id;
  }

  /**
   * 取出一批待轉送事件並鎖定（FOR UPDATE SKIP LOCKED），可安全地多 worker 併行。
   * 必須在交易中呼叫，鎖才有意義。
   */
  async claimBatch(tx: Tx, limit: number): Promise<OutboxRow[]> {
    const result = await tx.execute<OutboxRow>(sql`
      SELECT id, event_name, event_version, payload, actor_id, correlation_id, occurred_at, attempts
      FROM platform_outbox
      WHERE status = 'pending' AND available_at <= now()
      ORDER BY occurred_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    return result.rows;
  }

  async markRelayed(tx: Tx, id: string): Promise<void> {
    await tx.execute(sql`
      UPDATE platform_outbox SET status = 'relayed', relayed_at = now(), last_error = NULL WHERE id = ${id}
    `);
  }

  async markFailed(tx: Tx, id: string, error: string, attempts: number): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    await tx.execute(sql`
      UPDATE platform_outbox
      SET attempts = ${attempts},
          last_error = ${error.slice(0, 2000)},
          available_at = now() + (${delaySeconds} * interval '1 second'),
          status = CASE WHEN ${attempts} >= 10 THEN 'dead' ELSE 'pending' END
      WHERE id = ${id}
    `);
  }

  async stats(db: DrizzleDb): Promise<{ pending: number; relayed: number; dead: number; oldestPendingAgeSeconds: number | null }> {
    const res = await db.execute<{ status: string; count: string; oldest: string | null }>(sql`
      SELECT status, count(*)::text AS count,
             EXTRACT(EPOCH FROM (now() - min(occurred_at)))::text AS oldest
      FROM platform_outbox GROUP BY status
    `);
    let pending = 0, relayed = 0, dead = 0, oldest: number | null = null;
    for (const row of res.rows) {
      const n = Number(row.count);
      if (row.status === 'pending') { pending = n; oldest = row.oldest ? Math.round(Number(row.oldest)) : null; }
      else if (row.status === 'relayed') relayed = n;
      else if (row.status === 'dead') dead = n;
    }
    return { pending, relayed, dead, oldestPendingAgeSeconds: oldest };
  }
}

export function toDomainEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.id,
    name: row.event_name,
    version: row.event_version,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    payload: row.payload,
  };
}
