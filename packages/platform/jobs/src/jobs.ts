import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DrizzleDb, Logger, Tx } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';

export { PermanentJobError } from '@storeweave/contracts';

export interface EnqueueInput {
  type: string;
  payload: unknown;
  /**
   * 唯一鍵。相同 dedupeKey 只會排入一次 —— 這是「重複處理不得重複產生外部副作用」的機制。
   */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  /**
   * 同一 dedupeKey 已存在時，以這次 payload 與時間重排它。
   * 這不是一般去重：只用在「同一件未來工作」改了截止時間的情況。
   */
  replaceExisting?: boolean;
}

export interface DeadJobRow {
  [key: string]: unknown;
  id: string;
  type: string;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  last_error: string | null;
  updated_at: Date;
}

export interface JobRow {
  [key: string]: unknown;
  id: string;
  type: string;
  payload: unknown;
  payload_version: number;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  occurrence_id: string;
  claim_token: string | null;
}

/** A fenced reference returned only by a successful claim. */
export interface JobClaim extends JobRow {
  jobId: string;
  occurrenceId: string;
  claimToken: string;
}

/** Normalized at the registry boundary and enforced by the atomic claim. */
export interface JobConcurrencyPolicy {
  readonly type: string;
  readonly key: string;
  readonly limit?: number;
}

export interface JobMutationResult {
  applied: boolean;
  status?: 'pending' | 'running' | 'completed' | 'dead' | 'cancelled' | 'quarantined' | 'dedupe_retained';
  cancelRequested?: boolean;
}

export interface JobFailResult extends JobMutationResult {
  outcome?: 'retry' | 'dead' | 'replaced' | 'cancelled';
}

/** enqueue 沒指定 `maxAttempts` 時的上限；handler 靠它判斷這是不是最後一次嘗試。 */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

export interface JobContext {
  readonly logger: Logger;
  readonly attempt: number;
  readonly jobId: string;
  /** Stable external-effect key for this logical occurrence; it survives retries and lease reclaim. */
  readonly occurrenceId: string;
  /** Alias of occurrenceId for providers which name their deduplication input explicitly. */
  readonly idempotencyKey: string;
  /** Cooperative cancellation for timeout, shutdown, and lost worker ownership. */
  readonly signal: AbortSignal;
  /** Core jobs may cross a Command/Query boundary; extension jobs stay on the SDK surface. */
  readonly executeCommand?: (name: string, input: unknown, idempotencyKey: string) => Promise<unknown>;
  readonly executeQuery?: (name: string, input: unknown) => Promise<unknown>;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

export interface JobRetentionPolicy {
  completedPayloadRetentionDays: number;
  cancelledPayloadRetentionDays: number;
  dedupeHorizonDays: number;
}

export interface JobMetadata {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  occurrenceId: string;
  runAt: Date;
  retainUntil: Date | null;
  dedupeUntil: Date | null;
  updatedAt: Date;
}

/** Public operations metadata; the original payload remains durable evidence, not list output. */
export interface QuarantinedJobRow {
  [key: string]: unknown;
  id: string;
  type: string;
  payload_version: number;
  occurrence_id: string;
  reason: string;
  created_at: Date;
}

const defaultRetentionPolicy: JobRetentionPolicy = {
  completedPayloadRetentionDays: 7,
  cancelledPayloadRetentionDays: 7,
  dedupeHorizonDays: 30,
};

/** Only dispatch preconditions use this marker; business failures retain normal retry semantics. */
export class JobQuarantineError extends Error {
  constructor(readonly reason: 'subscriber_missing' | 'event_unknown' | 'event_version_invalid' | 'event_payload_invalid') {
    super(reason);
    this.name = 'JobQuarantineError';
  }
}

export class JobQueue {
  private payloadVersionFor?: (type: string) => number;
  private retentionPolicy: JobRetentionPolicy = defaultRetentionPolicy;

  /** Kernel binds this after every owner is registered; callers never select a persisted version. */
  setPayloadVersionResolver(resolver: (type: string) => number): void { this.payloadVersionFor = resolver; }
  /** Runtime config is the sole policy source; the queue keeps a safe default for isolated migration tests. */
  setRetentionPolicy(policy: JobRetentionPolicy): void {
    if (!Number.isSafeInteger(policy.completedPayloadRetentionDays) || policy.completedPayloadRetentionDays <= 0
      || !Number.isSafeInteger(policy.cancelledPayloadRetentionDays) || policy.cancelledPayloadRetentionDays <= 0
      || !Number.isSafeInteger(policy.dedupeHorizonDays) || policy.dedupeHorizonDays < Math.max(policy.completedPayloadRetentionDays, policy.cancelledPayloadRetentionDays)) {
      throw new Error('Invalid job retention policy');
    }
    this.retentionPolicy = { ...policy };
  }
  /** 在交易內排入工作。dedupeKey 衝突時預設視為已排入（no-op）。 */
  async enqueue(tx: Tx, input: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
    const id = randomUUID();
    const occurrenceId = randomUUID();
    const payloadVersion = this.payloadVersionFor?.(input.type) ?? 1;
    // 佇列的時間權威只有資料庫：預設 run_at 用伺服器 now()，避免呼叫端與 PG 之間的
    // 時鐘偏移讓剛入列的工作在 `run_at <= now()` 底下暫時取不到。明確指定的排程時間才用呼叫端的值。
    const runAt = input.runAt ? sql`CAST(${input.runAt.toISOString()} AS timestamptz)` : sql`now()`;
    const maxAttempts = input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
    let res = await tx.execute<{ id: string }>(sql`
      INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, run_at, max_attempts)
      VALUES (${id}, ${occurrenceId}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb,
              ${payloadVersion}, ${input.dedupeKey ?? null}, ${runAt}, ${maxAttempts})
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    if (res.rows.length > 0) return { id: res.rows[0].id, deduped: false };

    if (!input.dedupeKey) throw new Error('Unexpected job insert conflict without a dedupe key');

    // A dedupe tombstone owns the key only through its horizon. Locking this
    // row before deleting it means a concurrent enqueue cannot pass through a
    // just-expired identity and create two replacement jobs.
    const expired = await tx.execute<{ id: string }>(sql`
      DELETE FROM platform_jobs
      WHERE id = (
        SELECT id FROM platform_jobs
        WHERE dedupe_key = ${input.dedupeKey} AND status = 'dedupe_retained'
          AND dedupe_until <= now()
        FOR UPDATE
      )
      RETURNING id
    `);
    if (expired.rows.length > 0) {
      res = await tx.execute<{ id: string }>(sql`
        INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, run_at, max_attempts)
        VALUES (${id}, ${occurrenceId}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb,
                ${payloadVersion}, ${input.dedupeKey}, ${runAt}, ${maxAttempts})
        RETURNING id
      `);
      if (res.rows.length > 0) return { id: res.rows[0].id, deduped: false };
    }

    // `ON CONFLICT DO NOTHING` establishes that a row existed at the time of
    // that statement, but it does not keep it locked. A cleanup worker can
    // delete an already-expired tombstone before the lock/delete above runs.
    // Retry the insert once to make that hand-off a new enqueue instead of
    // dereferencing a row which legitimately no longer exists.
    if (expired.rows.length === 0) {
      res = await tx.execute<{ id: string }>(sql`
        INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, run_at, max_attempts)
        VALUES (${id}, ${occurrenceId}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb,
                ${payloadVersion}, ${input.dedupeKey}, ${runAt}, ${maxAttempts})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      `);
      if (res.rows.length > 0) return { id: res.rows[0].id, deduped: false };
    }
    if (!input.replaceExisting) {
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id FROM platform_jobs WHERE dedupe_key = ${input.dedupeKey}
      `);
      return { id: existing.rows[0]!.id, deduped: true };
    }

    // A running occurrence remains fenced until it reaches a terminal transition. The single
    // deferred slot deliberately makes repeated replacement requests latest-wins. Once a
    // cancellation has been accepted, however, it is the terminal decision: a later replace
    // must not clear it or recreate deferred work that cancellation deliberately removed.
    const nextOccurrenceId = randomUUID();
    const replaced = await tx.execute<{ id: string }>(sql`
      UPDATE platform_jobs
      SET deferred_type = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN ${input.type} ELSE NULL END,
          deferred_payload = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN ${JSON.stringify(input.payload ?? {})}::jsonb ELSE NULL END,
          deferred_payload_version = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN CAST(${payloadVersion} AS integer) ELSE NULL END,
          deferred_run_at = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN ${runAt} ELSE NULL END,
          deferred_max_attempts = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN CAST(${maxAttempts} AS integer) ELSE NULL END,
          deferred_at = CASE WHEN status = 'running' AND cancel_requested_at IS NULL THEN now() ELSE NULL END,
          type = CASE WHEN status = 'running' THEN type ELSE ${input.type} END,
          payload = CASE WHEN status = 'running' THEN payload ELSE ${JSON.stringify(input.payload ?? {})}::jsonb END,
          payload_version = CASE WHEN status = 'running' THEN payload_version ELSE CAST(${payloadVersion} AS integer) END,
          run_at = CASE WHEN status = 'running' THEN run_at ELSE ${runAt} END,
          max_attempts = CASE WHEN status = 'running' THEN max_attempts ELSE CAST(${maxAttempts} AS integer) END,
          status = CASE WHEN status = 'running' THEN status ELSE 'pending' END,
          attempts = CASE WHEN status = 'running' THEN attempts ELSE 0 END,
          occurrence_id = CASE WHEN status = 'running' THEN occurrence_id ELSE ${nextOccurrenceId} END,
          claim_token = CASE WHEN status = 'running' THEN claim_token ELSE NULL END,
          locked_at = CASE WHEN status = 'running' THEN locked_at ELSE NULL END,
          locked_by = CASE WHEN status = 'running' THEN locked_by ELSE NULL END,
          lease_expires_at = CASE WHEN status = 'running' THEN lease_expires_at ELSE NULL END,
          last_error = NULL, completed_at = NULL,
          cancel_requested_at = CASE WHEN status = 'running' THEN cancel_requested_at ELSE NULL END,
          cancelled_at = NULL,
          retain_until = NULL, dedupe_until = NULL, updated_at = now()
      WHERE dedupe_key = ${input.dedupeKey}
      RETURNING id
    `);
    return { id: replaced.rows[0]!.id, deduped: true };
  }

  /** Persist an undecodable claimed occurrence instead of running its handler or silently deleting it. */
  async quarantine(db: DrizzleDb, claim: JobClaim, reason: string): Promise<JobMutationResult> {
    const nextOccurrenceId = randomUUID();
    const res = await db.execute<{ status: 'pending' | 'cancelled' | 'quarantined' }>(sql`
      WITH target AS (
        SELECT id, occurrence_id, type, payload, payload_version,
          deferred_at IS NOT NULL AS has_deferred, cancel_requested_at IS NOT NULL AS cancelling,
          deferred_type, deferred_payload, deferred_payload_version, deferred_run_at, deferred_max_attempts
        FROM platform_jobs
        WHERE id = ${claim.jobId} AND occurrence_id = ${claim.occurrenceId}
          AND claim_token = ${claim.claimToken} AND status = 'running'
        FOR UPDATE
      ), transition AS (
        UPDATE platform_jobs AS job
        SET status = CASE WHEN target.cancelling THEN 'cancelled' WHEN target.has_deferred THEN 'pending' ELSE 'quarantined' END,
            type = CASE WHEN target.has_deferred AND NOT target.cancelling THEN target.deferred_type ELSE job.type END,
            payload = CASE WHEN target.has_deferred AND NOT target.cancelling THEN target.deferred_payload ELSE job.payload END,
            payload_version = CASE WHEN target.has_deferred AND NOT target.cancelling THEN target.deferred_payload_version ELSE job.payload_version END,
            run_at = CASE WHEN target.has_deferred AND NOT target.cancelling THEN target.deferred_run_at ELSE job.run_at END,
            max_attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN target.deferred_max_attempts ELSE job.max_attempts END,
            attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN 0 ELSE job.attempts END,
            occurrence_id = CASE WHEN target.has_deferred AND NOT target.cancelling THEN ${nextOccurrenceId} ELSE job.occurrence_id END,
            claim_token = NULL, locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
            deferred_type = NULL, deferred_payload = NULL, deferred_payload_version = NULL,
            deferred_run_at = NULL, deferred_max_attempts = NULL, deferred_at = NULL,
            last_error = CASE WHEN target.cancelling OR target.has_deferred THEN NULL ELSE ${reason.slice(0, 2000)} END,
            completed_at = NULL, cancelled_at = CASE WHEN target.cancelling THEN now() ELSE NULL END,
            retain_until = CASE WHEN target.cancelling THEN now() + (${this.retentionPolicy.cancelledPayloadRetentionDays} * interval '1 day') ELSE NULL END,
            dedupe_until = CASE WHEN target.cancelling THEN now() + (${this.retentionPolicy.dedupeHorizonDays} * interval '1 day') ELSE NULL END,
            updated_at = now()
        FROM target
        WHERE job.id = target.id
        RETURNING job.status
      ), evidence AS (
        INSERT INTO platform_job_quarantine (job_id, occurrence_id, type, payload, payload_version, reason)
        SELECT id, occurrence_id, type, payload, payload_version, ${reason.slice(0, 2000)} FROM target
        ON CONFLICT (job_id, occurrence_id) DO NOTHING
        RETURNING job_id
      )
      SELECT status FROM transition WHERE EXISTS (SELECT 1 FROM evidence)
    `);
    return res.rows[0] ? { applied: true, status: res.rows[0].status } : { applied: false };
  }

  /** Preserve dedupe identity and old quarantine evidence while starting a new execution occurrence. */
  async redriveQuarantined(db: DrizzleDb, id: string): Promise<JobMutationResult> {
    const result = await db.execute<{ status: 'pending' }>(sql`
      UPDATE platform_jobs
      SET status = 'pending', occurrence_id = ${randomUUID()}, claim_token = NULL,
          locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
          attempts = 0, last_error = NULL, completed_at = NULL, cancelled_at = NULL,
          cancel_requested_at = NULL, retain_until = NULL, dedupe_until = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'quarantined'
      RETURNING status
    `);
    if (result.rows[0]) return { applied: true, status: 'pending' };
    const current = await db.execute<{ status: string }>(sql`SELECT status FROM platform_jobs WHERE id = ${id}`);
    if (current.rows[0]) throw PlatformError.conflict(`Job ${id} cannot be redriven from ${current.rows[0].status}`);
    throw PlatformError.notFound('Quarantined job', id);
  }

  /** 鎖定一批待處理工作。必須在交易中呼叫。 */
  async claim(
    tx: Tx, workerId: string, limit: number, types?: readonly string[], leaseSeconds = 60,
    concurrency: readonly JobConcurrencyPolicy[] = [],
  ): Promise<JobClaim[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid claim limit: ${limit}`);
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error(`Invalid claim lease: ${leaseSeconds}`);
    const typeFilter = types && types.length > 0 ? sql`AND candidate.type = ANY(${sql.raw(`ARRAY[${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')}]`)})` : sql``;
    const policies = concurrency.filter(policy => policy.limit !== undefined);
    const policyValues = policies.length === 0 ? sql`SELECT NULL::text AS type, NULL::text AS key, NULL::integer AS limit WHERE false` : sql.raw(
      `VALUES ${policies.map(policy => `('${policy.type.replace(/'/g, "''")}', '${policy.key.replace(/'/g, "''")}', ${policy.limit})`).join(', ')}`,
    );
    if (policies.length > 0) {
      const keys = [...new Set(policies.map(policy => policy.key))].sort();
      // This must be its own fully-consumed statement. PostgreSQL takes a new
      // READ COMMITTED snapshot for the following count/update only after any
      // wait here has completed; a same-statement CTE would retain a stale
      // snapshot and can overclaim after another worker commits its lease.
      await tx.execute(sql`
        SELECT concurrency_key, pg_advisory_xact_lock(hashtextextended(concurrency_key, 0))
        FROM (VALUES ${sql.raw(keys.map(key => `('${key.replace(/'/g, "''")}')`).join(', '))}) AS keys(concurrency_key)
        ORDER BY concurrency_key
      `);
    }
    const res = await tx.execute<JobRow>(sql`
      WITH policies(type, concurrency_key, concurrency_limit) AS (${policyValues}),
      eligible AS MATERIALIZED (
        SELECT candidate.id, candidate.run_at, policies.concurrency_key, policies.concurrency_limit,
          CASE WHEN policies.concurrency_limit IS NULL THEN 0 ELSE (
            SELECT count(*)
            FROM platform_jobs AS running
            JOIN policies AS running_policy ON running_policy.type = running.type
            WHERE running.status = 'running' AND running.lease_expires_at > now()
              AND running_policy.concurrency_key = policies.concurrency_key
          ) END AS active_count
        FROM platform_jobs AS candidate
        LEFT JOIN policies ON policies.type = candidate.type
        WHERE candidate.status = 'pending' AND candidate.run_at <= now()
          AND candidate.cancel_requested_at IS NULL ${typeFilter}
        FOR UPDATE SKIP LOCKED
      ), selected AS MATERIALIZED (
        SELECT id
        FROM (
          SELECT eligible.*, row_number() OVER (PARTITION BY concurrency_key ORDER BY run_at, id) AS key_position
          FROM eligible
        ) AS ranked
        WHERE concurrency_limit IS NULL OR key_position <= concurrency_limit - active_count
        ORDER BY run_at
        LIMIT ${limit}
      )
      UPDATE platform_jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
             claim_token = md5(random()::text || clock_timestamp()::text || id::text || 'claim')::uuid,
             lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
             attempts = attempts + 1, cancel_requested_at = NULL, updated_at = now()
      WHERE id IN (SELECT id FROM selected)
      RETURNING id, type, payload, payload_version, attempts, max_attempts, dedupe_key, occurrence_id, claim_token
    `);
    return res.rows.map((row) => ({
      ...row, jobId: row.id, occurrenceId: row.occurrence_id, claimToken: row.claim_token!,
    }));
  }

  /** Extends a fenced lease. Worker scheduling of periodic heartbeats is a later slice. */
  async heartbeat(db: DrizzleDb, claim: JobClaim, leaseSeconds = 60): Promise<JobMutationResult> {
    const res = await db.execute<{ status: 'running'; cancel_requested: boolean }>(sql`
      UPDATE platform_jobs SET lease_expires_at = now() + (${leaseSeconds} * interval '1 second'), updated_at = now()
      WHERE id = ${claim.jobId} AND occurrence_id = ${claim.occurrenceId}
        AND claim_token = ${claim.claimToken} AND status = 'running'
      RETURNING status, cancel_requested_at IS NOT NULL AS cancel_requested
    `);
    return res.rows[0] ? { applied: true, status: 'running', cancelRequested: res.rows[0].cancel_requested } : { applied: false };
  }

  async complete(db: DrizzleDb, claim: JobClaim): Promise<JobMutationResult> {
    const nextOccurrenceId = randomUUID();
    const res = await db.execute<{ status: 'pending' | 'completed' | 'cancelled' }>(sql`
      WITH target AS (
        SELECT id, deferred_at IS NOT NULL AS has_deferred, cancel_requested_at IS NOT NULL AS cancelling
        FROM platform_jobs
        WHERE id = ${claim.jobId} AND occurrence_id = ${claim.occurrenceId}
          AND claim_token = ${claim.claimToken} AND status = 'running'
        FOR UPDATE
      )
      UPDATE platform_jobs AS job
      SET status = CASE WHEN target.cancelling THEN 'cancelled' WHEN target.has_deferred THEN 'pending' ELSE 'completed' END,
          type = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_type ELSE type END,
          payload = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_payload ELSE payload END,
          payload_version = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_payload_version ELSE payload_version END,
          run_at = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_run_at ELSE run_at END,
          max_attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_max_attempts ELSE max_attempts END,
          attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN 0 ELSE attempts END,
          occurrence_id = CASE WHEN target.has_deferred AND NOT target.cancelling THEN ${nextOccurrenceId} ELSE occurrence_id END,
          claim_token = NULL, locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
          deferred_type = NULL, deferred_payload = NULL, deferred_payload_version = NULL,
          deferred_run_at = NULL, deferred_max_attempts = NULL, deferred_at = NULL,
          last_error = NULL,
          completed_at = CASE WHEN target.cancelling OR target.has_deferred THEN NULL ELSE now() END,
          cancelled_at = CASE WHEN target.cancelling THEN now() ELSE NULL END,
          retain_until = CASE WHEN target.has_deferred THEN NULL
                         WHEN target.cancelling THEN now() + (${this.retentionPolicy.cancelledPayloadRetentionDays} * interval '1 day')
                         ELSE now() + (${this.retentionPolicy.completedPayloadRetentionDays} * interval '1 day') END,
          dedupe_until = CASE WHEN target.has_deferred THEN NULL
                         ELSE now() + (${this.retentionPolicy.dedupeHorizonDays} * interval '1 day') END,
          updated_at = now()
      FROM target
      WHERE job.id = target.id
      RETURNING job.status
    `);
    return res.rows[0] ? { applied: true, status: res.rows[0].status } : { applied: false };
  }

  async fail(db: DrizzleDb, claim: JobClaim, error: string, permanent = false): Promise<JobFailResult> {
    const exhausted = permanent || claim.attempts >= claim.max_attempts;
    const delaySeconds = Math.min(600, 2 ** Math.min(claim.attempts, 9));
    const nextOccurrenceId = randomUUID();
    const res = await db.execute<{ status: 'pending' | 'dead' | 'cancelled'; has_deferred: boolean; cancelling: boolean }>(sql`
      WITH target AS (
        SELECT id, deferred_at IS NOT NULL AS has_deferred, cancel_requested_at IS NOT NULL AS cancelling
        FROM platform_jobs
        WHERE id = ${claim.jobId} AND occurrence_id = ${claim.occurrenceId}
          AND claim_token = ${claim.claimToken} AND status = 'running'
        FOR UPDATE
      )
      UPDATE platform_jobs AS job
      SET status = CASE WHEN target.cancelling THEN 'cancelled' WHEN target.has_deferred THEN 'pending' ELSE ${exhausted ? 'dead' : 'pending'} END,
          type = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_type ELSE type END,
          payload = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_payload ELSE payload END,
          payload_version = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_payload_version ELSE payload_version END,
          run_at = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_run_at ELSE now() + (${delaySeconds} * interval '1 second') END,
          max_attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN deferred_max_attempts ELSE max_attempts END,
          attempts = CASE WHEN target.has_deferred AND NOT target.cancelling THEN 0 ELSE attempts END,
          occurrence_id = CASE WHEN target.has_deferred AND NOT target.cancelling THEN ${nextOccurrenceId} ELSE occurrence_id END,
          claim_token = NULL, locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
          deferred_type = NULL, deferred_payload = NULL, deferred_payload_version = NULL,
          deferred_run_at = NULL, deferred_max_attempts = NULL, deferred_at = NULL,
          last_error = CASE WHEN target.cancelling OR target.has_deferred THEN NULL ELSE ${error.slice(0, 2000)} END,
          completed_at = NULL, cancelled_at = CASE WHEN target.cancelling THEN now() ELSE NULL END,
          retain_until = CASE WHEN target.cancelling THEN now() + (${this.retentionPolicy.cancelledPayloadRetentionDays} * interval '1 day') ELSE NULL END,
          dedupe_until = CASE WHEN target.cancelling THEN now() + (${this.retentionPolicy.dedupeHorizonDays} * interval '1 day') ELSE NULL END,
          updated_at = now()
      FROM target
      WHERE job.id = target.id
      RETURNING job.status, target.has_deferred, target.cancelling
    `);
    const row = res.rows[0];
    if (!row) return { applied: false };
    const outcome = row.cancelling ? 'cancelled' : row.has_deferred ? 'replaced' : row.status === 'dead' ? 'dead' : 'retry';
    return { applied: true, status: row.status, outcome };
  }

  /** Cancels the whole persisted identity; a running handler observes cancellation cooperatively. */
  async cancel(db: DrizzleDb, input: { jobId: string; occurrenceId: string }): Promise<JobMutationResult> {
    const res = await db.execute<{ status: 'running' | 'cancelled' }>(sql`
      UPDATE platform_jobs
      SET deferred_type = NULL, deferred_payload = NULL, deferred_payload_version = NULL,
          deferred_run_at = NULL, deferred_max_attempts = NULL, deferred_at = NULL,
          cancel_requested_at = now(),
          status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
          cancelled_at = CASE WHEN status = 'pending' THEN now() ELSE cancelled_at END,
          retain_until = CASE WHEN status = 'pending' THEN now() + (${this.retentionPolicy.cancelledPayloadRetentionDays} * interval '1 day') ELSE retain_until END,
          dedupe_until = CASE WHEN status = 'pending' THEN now() + (${this.retentionPolicy.dedupeHorizonDays} * interval '1 day') ELSE dedupe_until END,
          updated_at = now()
      WHERE id = ${input.jobId} AND occurrence_id = ${input.occurrenceId}
        AND (status = 'pending' OR (status = 'running' AND cancel_requested_at IS NULL))
      RETURNING status
    `);
    if (res.rows[0]) return { applied: true, status: res.rows[0].status };
    const current = await db.execute<{ occurrence_id: string; status: string }>(sql`
      SELECT occurrence_id, status FROM platform_jobs WHERE id = ${input.jobId}
    `);
    if (!current.rows[0]) throw PlatformError.notFound('Job', input.jobId);
    if (current.rows[0].occurrence_id !== input.occurrenceId) {
      throw PlatformError.conflict(`Job ${input.jobId} occurrence has been replaced`);
    }
    throw PlatformError.conflict(`Job ${input.jobId} cannot be cancelled from ${current.rows[0].status}`);
  }

  /** 人工重送：只把 terminal job 放回佇列，不能旁路 running occurrence 的 fencing。 */
  async requeue(db: DrizzleDb, id: string, typePrefix?: string): Promise<void> {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE platform_jobs
      SET status = 'pending', run_at = now(), attempts = 0, last_error = NULL,
          occurrence_id = CASE WHEN status = 'completed'
                          THEN md5(random()::text || clock_timestamp()::text || id::text)::uuid
                          ELSE occurrence_id END,
          locked_at = NULL, locked_by = NULL, claim_token = NULL, lease_expires_at = NULL,
          completed_at = NULL, cancel_requested_at = NULL, cancelled_at = NULL,
          retain_until = NULL, dedupe_until = NULL, updated_at = now()
      WHERE id = ${id} AND status IN ('dead', 'completed') ${typePrefix ? sql`AND type LIKE ${`${typePrefix}%`}` : sql``}
      RETURNING id
    `);
    if (res.rows.length > 0) return;
    const current = await db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE id = ${id} ${typePrefix ? sql`AND type LIKE ${`${typePrefix}%`}` : sql``}
    `);
    if (current.rows[0]) throw PlatformError.conflict(`Job ${id} cannot be requeued from ${current.rows[0].status}`);
    throw PlatformError.notFound('Job', id);
  }

  /**
   * 死信專用的重送：只放行 status = 'dead' 的工作。
   * 與 requeue 分開是刻意的 —— 對 completed 的工作重送會再產生一次外部副作用。
   */
  async retryDead(db: DrizzleDb, id: string, typePrefix?: string): Promise<void> {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE platform_jobs
      SET status = 'pending', run_at = now(), attempts = 0, last_error = NULL,
          locked_at = NULL, locked_by = NULL, claim_token = NULL, lease_expires_at = NULL,
          completed_at = NULL, cancelled_at = NULL, cancel_requested_at = NULL,
          retain_until = NULL, dedupe_until = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'dead' ${typePrefix ? sql`AND type LIKE ${`${typePrefix}%`}` : sql``}
      RETURNING id
    `);
    if (res.rows.length > 0) return;
    const current = await db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE id = ${id} ${typePrefix ? sql`AND type LIKE ${`${typePrefix}%`}` : sql``}
    `);
    if (current.rows[0]) throw PlatformError.conflict(`Dead job ${id} cannot be retried from ${current.rows[0].status}`);
    throw PlatformError.notFound('Dead job', id);
  }

  /**
   * Recover a lost lease through the same finite retry semantics as fail().
   * A process crash has already consumed its claim attempt, so it must never
   * become an unlimited sequence of fresh claims.
   */
  async reclaimStale(db: DrizzleDb, _legacyOlderThanSeconds?: number): Promise<number> {
    const res = await db.execute<{ id: string }>(sql`
      WITH stale AS (
        SELECT id, occurrence_id, claim_token, attempts, max_attempts,
          deferred_at IS NOT NULL AS has_deferred, cancel_requested_at IS NOT NULL AS cancelling,
          deferred_type, deferred_payload, deferred_payload_version, deferred_run_at, deferred_max_attempts
        FROM platform_jobs
        WHERE status = 'running' AND (
          lease_expires_at < now()
          OR (claim_token IS NULL AND (locked_at IS NULL OR locked_at < now()))
        )
        FOR UPDATE SKIP LOCKED
      )
      UPDATE platform_jobs AS job
      SET status = CASE WHEN stale.cancelling THEN 'cancelled' WHEN stale.has_deferred THEN 'pending'
                    WHEN stale.attempts >= stale.max_attempts THEN 'dead' ELSE 'pending' END,
          type = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN stale.deferred_type ELSE job.type END,
          payload = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN stale.deferred_payload ELSE job.payload END,
          payload_version = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN stale.deferred_payload_version ELSE job.payload_version END,
          run_at = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN stale.deferred_run_at
                    WHEN stale.cancelling OR stale.attempts >= stale.max_attempts THEN job.run_at
                    ELSE now() + (LEAST(600, power(2, LEAST(stale.attempts, 9))) * interval '1 second') END,
          max_attempts = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN stale.deferred_max_attempts ELSE job.max_attempts END,
          attempts = CASE WHEN stale.has_deferred AND NOT stale.cancelling THEN 0 ELSE job.attempts END,
          occurrence_id = CASE WHEN stale.has_deferred AND NOT stale.cancelling
                          THEN md5(random()::text || clock_timestamp()::text || job.id::text)::uuid ELSE job.occurrence_id END,
          locked_at = NULL, locked_by = NULL, claim_token = NULL, lease_expires_at = NULL,
          deferred_type = NULL, deferred_payload = NULL, deferred_payload_version = NULL,
          deferred_run_at = NULL, deferred_max_attempts = NULL, deferred_at = NULL,
          last_error = CASE WHEN stale.cancelling OR stale.has_deferred THEN NULL ELSE 'worker lease expired' END,
          completed_at = NULL, cancelled_at = CASE WHEN stale.cancelling THEN now() ELSE NULL END,
          retain_until = CASE WHEN stale.cancelling THEN now() + (${this.retentionPolicy.cancelledPayloadRetentionDays} * interval '1 day') ELSE NULL END,
          dedupe_until = CASE WHEN stale.cancelling THEN now() + (${this.retentionPolicy.dedupeHorizonDays} * interval '1 day') ELSE NULL END,
          updated_at = now()
      FROM stale
      WHERE job.id = stale.id AND job.occurrence_id = stale.occurrence_id
        AND job.claim_token IS NOT DISTINCT FROM stale.claim_token AND job.status = 'running'
      RETURNING job.id
    `);
    return res.rows.length;
  }

  /**
   * Bounded, lock-safe expiry. It is deliberately called from the worker
   * lifecycle instead of a second scheduler: a fresh enqueue locks/removes an
   * expired tombstone in its own transaction, while this path only touches
   * terminal identities and never deletes dead or quarantine evidence.
   */
  async cleanupExpired(db: DrizzleDb, limit: number): Promise<{ tombstoned: number; deleted: number; expired: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid retention cleanup limit: ${limit}`);
    const result = await db.execute<{ tombstoned: string; deleted: string; expired: string }>(sql`
      WITH terminal AS MATERIALIZED (
        SELECT id, dedupe_key
        FROM platform_jobs
        WHERE status IN ('completed', 'cancelled') AND retain_until <= now()
        ORDER BY retain_until, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), tombstoned AS (
        UPDATE platform_jobs AS job
        SET status = 'dedupe_retained', payload = NULL,
            attempts = 0, max_attempts = 0, run_at = now(), locked_at = NULL, locked_by = NULL,
            claim_token = NULL, lease_expires_at = NULL, deferred_type = NULL, deferred_payload = NULL,
            deferred_payload_version = NULL, deferred_run_at = NULL, deferred_max_attempts = NULL,
            deferred_at = NULL, cancel_requested_at = NULL, cancelled_at = NULL, completed_at = NULL,
            last_error = NULL, retain_until = NULL, updated_at = now()
        FROM terminal
        WHERE job.id = terminal.id AND terminal.dedupe_key IS NOT NULL
        RETURNING job.id
      ), removed AS (
        DELETE FROM platform_jobs AS job
        USING terminal
        WHERE job.id = terminal.id AND terminal.dedupe_key IS NULL
        RETURNING job.id
      ), expired_tombstones AS (
        DELETE FROM platform_jobs
        WHERE id IN (
          SELECT id FROM platform_jobs
          WHERE status = 'dedupe_retained' AND dedupe_until <= now()
          ORDER BY dedupe_until, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      )
      SELECT (SELECT count(*)::text FROM tombstoned) AS tombstoned,
             (SELECT count(*)::text FROM removed) AS deleted,
             (SELECT count(*)::text FROM expired_tombstones) AS expired
    `);
    const row = result.rows[0]!;
    return { tombstoned: Number(row.tombstoned), deleted: Number(row.deleted), expired: Number(row.expired) };
  }

  async stats(db: DrizzleDb): Promise<Record<string, number>> {
    const res = await db.execute<{ status: string; count: string }>(
      sql`SELECT status, count(*)::text AS count FROM platform_jobs GROUP BY status`,
    );
    const out: Record<string, number> = {
      pending: 0, running: 0, completed: 0, dead: 0, cancelled: 0, quarantined: 0, dedupe_retained: 0,
    };
    for (const r of res.rows) out[r.status] = Number(r.count);
    return out;
  }

  /** 列出耗盡重試而進入死信佇列的工作，最近失敗的排在前面。 */
  async listDead(db: DrizzleDb, options: { limit: number; offset: number }): Promise<{ items: DeadJobRow[]; total: number }> {
    const res = await db.execute<DeadJobRow>(sql`
      SELECT id, type, attempts, max_attempts, dedupe_key, last_error, updated_at
      FROM platform_jobs WHERE status = 'dead'
      ORDER BY updated_at DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `);
    const count = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM platform_jobs WHERE status = 'dead'`,
    );
    return { items: res.rows, total: Number(count.rows[0]?.count ?? 0) };
  }

  /** Current quarantines only; historical payload evidence stays immutable after redrive. */
  async listQuarantined(db: DrizzleDb, options: { limit: number; offset: number }): Promise<{ items: QuarantinedJobRow[]; total: number }> {
    const rows = await db.execute<QuarantinedJobRow>(sql`
      SELECT job.id, job.type, job.payload_version, job.occurrence_id, quarantine.reason, quarantine.created_at
      FROM platform_jobs AS job
      JOIN platform_job_quarantine AS quarantine
        ON quarantine.job_id = job.id AND quarantine.occurrence_id = job.occurrence_id
      WHERE job.status = 'quarantined'
      ORDER BY quarantine.created_at DESC, job.id DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `);
    const count = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM platform_jobs AS job
      JOIN platform_job_quarantine AS quarantine
        ON quarantine.job_id = job.id AND quarantine.occurrence_id = job.occurrence_id
      WHERE job.status = 'quarantined'
    `);
    return { items: rows.rows, total: Number(count.rows[0]?.count ?? 0) };
  }

  async findByDedupeKey(db: DrizzleDb, key: string): Promise<(JobRow & { status: string; last_error: string | null }) | null> {
    const res = await db.execute<JobRow & { status: string; last_error: string | null }>(sql`
      SELECT id, type, payload, payload_version, attempts, max_attempts, dedupe_key,
             occurrence_id, claim_token, status, last_error
      FROM platform_jobs WHERE dedupe_key = ${key}
    `);
    return res.rows[0] ?? null;
  }

  /** Safe for future ops callers: it intentionally never exposes job payload or error text. */
  async getMetadata(db: DrizzleDb, id: string): Promise<JobMetadata | null> {
    const res = await db.execute<{
      id: string; type: string; status: string; attempts: number; max_attempts: number; dedupe_key: string | null;
      occurrence_id: string; run_at: Date; retain_until: Date | null; dedupe_until: Date | null; updated_at: Date;
    }>(sql`
      SELECT id, type, status, attempts, max_attempts, dedupe_key, occurrence_id,
             run_at, retain_until, dedupe_until, updated_at
      FROM platform_jobs WHERE id = ${id}
    `);
    const row = res.rows[0];
    return row ? {
      id: row.id, type: row.type, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
      dedupeKey: row.dedupe_key, occurrenceId: row.occurrence_id, runAt: row.run_at,
      retainUntil: row.retain_until, dedupeUntil: row.dedupe_until, updatedAt: row.updated_at,
    } : null;
  }
}
