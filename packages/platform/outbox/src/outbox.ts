import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { EVENT_DELIVERY_JOB, PlatformError, type DomainEvent, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { platformSchema, validateEffectiveReleaseHistoryRecord, type EffectiveReleaseHistoryRecord } from '@storeweave/db';

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
  subscriber_ids: unknown | null;
}

export interface AppendInput {
  name: string;
  version: number;
  payload: unknown;
  actorId: string;
  correlationId: string;
  occurredAt?: Date;
  /** The command boundary captures this exact sorted set; [] is a valid terminal fan-out. */
  subscriberIds: readonly string[];
}

export interface OutboxQuarantineRow extends Record<string, unknown> {
  outbox_id: string;
  event_name: string;
  event_version: number;
  payload: unknown;
  subscriber_ids: unknown | null;
  reason: string;
  created_at: Date;
}

/** Public operations metadata; intentionally excludes an event payload. */
export interface OutboxFailureRow extends Record<string, unknown> {
  id: string;
  event_name: string;
  event_version: number;
  status: 'dead' | 'quarantined' | 'relayed';
  attempts: number;
  subscriber_ids: unknown | null;
  reason: string | null;
  occurred_at: Date;
}

interface EffectiveReleaseRow extends EffectiveReleaseHistoryRecord, Record<string, unknown> { recorded_at: Date | string; }

/**
 * A persisted `subscriber_ids` value is either a frozen string array, SQL NULL meaning the
 * legacy set is unknown, or corrupt. Callers must not conflate the last two, so this returns
 * `undefined` for anything that is not a string array and leaves the NULL check to them.
 */
export function asSubscriberSnapshot(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : undefined;
}

export function normalizeSubscriberSnapshot(ids: readonly string[]): string[] {
  if (ids.some(id => !id.trim())) throw new Error('Outbox subscriber id must be non-empty');
  return [...new Set(ids)].sort();
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
      subscriberIds: normalizeSubscriberSnapshot(input.subscriberIds),
    });
    return id;
  }

  /**
   * 取出一批待轉送事件並鎖定（FOR UPDATE SKIP LOCKED），可安全地多 worker 併行。
   * 必須在交易中呼叫，鎖才有意義。
   */
  async claimOne(tx: Tx): Promise<OutboxRow | undefined> {
    const result = await tx.execute<OutboxRow>(sql`
      SELECT id, event_name, event_version, payload, actor_id, correlation_id, occurred_at, attempts, subscriber_ids
      FROM platform_outbox
      WHERE status = 'pending' AND available_at <= now()
      ORDER BY occurred_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    return result.rows[0];
  }

  async markRelayed(tx: Tx, id: string): Promise<void> {
    await tx.execute(sql`
      UPDATE platform_outbox SET status = 'relayed', relayed_at = now(), last_error = NULL WHERE id = ${id}
    `);
  }

  async quarantine(tx: Tx, row: OutboxRow, reason: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine
        (outbox_id, event_name, event_version, payload, subscriber_ids, reason)
      VALUES (${row.id}, ${row.event_name}, ${row.event_version}, ${JSON.stringify(row.payload)}::jsonb,
        ${row.subscriber_ids === null ? null : JSON.stringify(row.subscriber_ids)}::jsonb, ${reason.slice(0, 2000)})
      ON CONFLICT (outbox_id) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE platform_outbox SET status = 'quarantined', last_error = ${reason.slice(0, 2000)}
      WHERE id = ${row.id} AND status = 'pending'
    `);
  }

  /** Persist a transient relay failure after the fan-out transaction rolled back. Never overwrite relayed state. */
  async recordTransientFailure(db: DrizzleDb, id: string, error: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_outbox
      SET attempts = attempts + 1,
          last_error = ${error.slice(0, 2000)},
          available_at = now() + (LEAST(300, power(2, LEAST(attempts + 1, 8))) * interval '1 second'),
          status = CASE WHEN attempts + 1 >= 10 THEN 'dead' ELSE 'pending' END
      WHERE id = ${id} AND status = 'pending'
    `);
  }

  async inspectQuarantine(db: DrizzleDb, outboxId: string): Promise<OutboxQuarantineRow | undefined> {
    const result = await db.execute<OutboxQuarantineRow>(sql`
      SELECT outbox_id, event_name, event_version, payload, subscriber_ids, reason, created_at
      FROM platform_outbox_quarantine WHERE outbox_id = ${outboxId}
    `);
    return result.rows[0];
  }

  /**
   * The only automatic legacy repair is a unique, already-recorded effective
   * release at the event time. Missing or malformed provenance remains NULL;
   * callers must quarantine rather than treating it as an empty fan-out.
   */
  async resolveSubscriberSnapshot(tx: Tx, row: OutboxRow): Promise<string[] | undefined> {
    const persisted = asSubscriberSnapshot(row.subscriber_ids);
    if (persisted) return normalizeSubscriberSnapshot(persisted);
    if (row.subscriber_ids !== null) return undefined;
    const history = await tx.execute<EffectiveReleaseRow>(sql`
      WITH latest AS (
        SELECT max(recorded_at) AS recorded_at FROM platform_release_history
        WHERE recorded_at <= ${row.occurred_at}
      )
      SELECT effective_manifest, effective_manifest_checksum, release_id, release_version, base_version,
        build_manifest_checksum, platform_release_history.recorded_at
      FROM platform_release_history JOIN latest USING (recorded_at)
      ORDER BY sequence
    `);
    // Two effective releases at one recorded timestamp cannot establish which
    // snapshot a legacy event observed. Do not break that tie by sequence.
    const candidate = history.rows.length === 1 ? history.rows[0] : undefined;
    if (!candidate) return undefined;
    let manifest;
    let recordedAt: Date;
    try {
      manifest = validateEffectiveReleaseHistoryRecord(candidate);
      recordedAt = new Date(candidate.recorded_at);
      if (Number.isNaN(recordedAt.getTime())) return undefined;
    } catch { return undefined; }
    const ids: string[] = [];
    for (const entry of manifest.owners) {
      if (entry.state === 'active' && entry.owner.work.subscribedEventNames.includes(row.event_name)) {
        ids.push(...entry.owner.work.subscriberIds);
      }
    }
    const snapshot = normalizeSubscriberSnapshot(ids);
    await tx.execute(sql`
      UPDATE platform_outbox SET subscriber_ids = ${JSON.stringify(snapshot)}::jsonb
      WHERE id = ${row.id} AND subscriber_ids IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine_audit (outbox_id, action, subscriber_ids, evidence)
      VALUES (${row.id}, 'reconstruct_snapshot', ${JSON.stringify(snapshot)}::jsonb,
        ${`effective_release_recorded_at=${recordedAt.toISOString()}`})
    `);
    return snapshot;
  }

  async repairSubscriberSnapshotInTransaction(tx: Tx, input: { outboxId: string; subscriberIds: readonly string[]; evidence: string }): Promise<void> {
    if (!input.evidence.trim()) throw PlatformError.validation('Outbox repair requires operator evidence');
    const snapshot = normalizeSubscriberSnapshot(input.subscriberIds);
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE platform_outbox SET subscriber_ids = ${JSON.stringify(snapshot)}::jsonb
      WHERE id = ${input.outboxId} AND subscriber_ids IS NULL
      RETURNING id
    `);
    if (!updated.rows[0]) throw PlatformError.conflict('Outbox repair requires an unknown legacy snapshot');
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine_audit (outbox_id, action, subscriber_ids, evidence)
      VALUES (${input.outboxId}, 'repair_snapshot', ${JSON.stringify(snapshot)}::jsonb, ${input.evidence.slice(0, 2000)})
    `);
  }

  async redriveQuarantinedInTransaction(tx: Tx, input: { outboxId: string; evidence: string }): Promise<void> {
    if (!input.evidence.trim()) throw PlatformError.validation('Outbox redrive requires operator evidence');
    const row = await tx.execute<{ subscriber_ids: unknown | null }>(sql`
      SELECT subscriber_ids FROM platform_outbox
      WHERE id = ${input.outboxId} AND status = 'quarantined' FOR UPDATE
    `);
    if (!row.rows[0] || row.rows[0].subscriber_ids === null) throw PlatformError.conflict('Outbox redrive requires a repaired subscriber snapshot');
    await tx.execute(sql`
      UPDATE platform_outbox SET status = 'pending', available_at = now(), last_error = NULL
      WHERE id = ${input.outboxId} AND status = 'quarantined'
    `);
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine_audit (outbox_id, action, subscriber_ids, evidence)
      VALUES (${input.outboxId}, 'redrive', ${JSON.stringify(row.rows[0].subscriber_ids)}::jsonb, ${input.evidence.slice(0, 2000)})
    `);
  }

  /** A manually acknowledged relay failure starts a fresh bounded retry sequence. */
  async retryDeadInTransaction(tx: Tx, input: { outboxId: string; evidence: string }): Promise<void> {
    if (!input.evidence.trim()) throw PlatformError.validation('Outbox retry requires operator evidence');
    const row = await tx.execute<{ subscriber_ids: unknown | null }>(sql`
      SELECT subscriber_ids FROM platform_outbox
      WHERE id = ${input.outboxId} AND status = 'dead' FOR UPDATE
    `);
    if (!row.rows[0]) throw PlatformError.conflict('Outbox retry requires a dead event');
    await tx.execute(sql`
      UPDATE platform_outbox SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL
      WHERE id = ${input.outboxId} AND status = 'dead'
    `);
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine_audit (outbox_id, action, subscriber_ids, evidence)
      VALUES (${input.outboxId}, 'retry_dead', ${JSON.stringify(row.rows[0].subscriber_ids)}::jsonb, ${input.evidence.slice(0, 2000)})
    `);
  }

  async auditDeliveryRedriveInTransaction(tx: Tx, input: { outboxId: string; subscriberIds: readonly string[]; evidence: string }): Promise<void> {
    if (!input.evidence.trim()) throw PlatformError.validation('Outbox redrive requires operator evidence');
    await tx.execute(sql`
      INSERT INTO platform_outbox_quarantine_audit (outbox_id, action, subscriber_ids, evidence)
      VALUES (${input.outboxId}, 'redrive_delivery', ${JSON.stringify(normalizeSubscriberSnapshot(input.subscriberIds))}::jsonb, ${input.evidence.slice(0, 2000)})
    `);
  }

  /**
   * Lists failed relays and relayed events with a quarantined delivery; remediation payloads
   * stay in evidence tables.
   *
   * Both candidate sets are small and indexed, and neither is derived by scanning the whole
   * outbox. `platform_outbox` has no retention in B04, so it grows without bound and is almost
   * entirely `relayed`: any predicate that has to look at every row — an `OR` with a correlated
   * `dedupe_key LIKE 'evt:<id>:%'` probe being the worst case — makes the endpoint slower exactly
   * as the store ages, on the one screen a cutover operator depends on. The delivery half is
   * therefore driven from the quarantined jobs and joined back on the outbox primary key.
   */
  async listFailures(db: DrizzleDb, options: { limit: number; offset: number }): Promise<{ items: OutboxFailureRow[]; total: number }> {
    const candidates = sql`
      failed(id) AS (
        SELECT id FROM platform_outbox WHERE status IN ('dead', 'quarantined')
        UNION
        SELECT split_part(delivery.dedupe_key, ':', 2)::uuid
        FROM platform_jobs AS delivery
        WHERE delivery.status = 'quarantined' AND delivery.type = ${EVENT_DELIVERY_JOB}
      )`;
    const rows = await db.execute<OutboxFailureRow>(sql`
      WITH ${candidates},
      delivery_quarantine AS (
        SELECT DISTINCT ON (outbox_id) outbox_id, reason FROM (
          SELECT split_part(delivery.dedupe_key, ':', 2)::uuid AS outbox_id,
                 evidence.reason, evidence.created_at, delivery.id
          FROM platform_jobs AS delivery
          JOIN platform_job_quarantine AS evidence
            ON evidence.job_id = delivery.id AND evidence.occurrence_id = delivery.occurrence_id
          WHERE delivery.status = 'quarantined' AND delivery.type = ${EVENT_DELIVERY_JOB}
        ) AS ranked
        ORDER BY outbox_id, created_at DESC, id DESC
      )
      SELECT event.id, event.event_name, event.event_version, event.status, event.attempts,
             event.subscriber_ids,
             COALESCE(quarantine.reason, delivery_quarantine.reason, event.last_error) AS reason,
             event.occurred_at
      FROM failed
      JOIN platform_outbox AS event ON event.id = failed.id
      LEFT JOIN platform_outbox_quarantine AS quarantine ON quarantine.outbox_id = event.id
      LEFT JOIN delivery_quarantine ON delivery_quarantine.outbox_id = event.id
      WHERE event.status IN ('dead', 'quarantined', 'relayed')
      ORDER BY event.occurred_at DESC, event.id DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `);
    const count = await db.execute<{ count: string }>(sql`
      WITH ${candidates}
      SELECT count(*)::text AS count
      FROM failed
      JOIN platform_outbox AS event ON event.id = failed.id
      WHERE event.status IN ('dead', 'quarantined', 'relayed')
    `);
    return { items: rows.rows, total: Number(count.rows[0]?.count ?? 0) };
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
