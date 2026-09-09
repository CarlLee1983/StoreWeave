import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { JobQuarantineError, type JobClaim } from '@storeweave/jobs';
import { toDomainEvent } from '@storeweave/outbox';
import type { Runtime } from './runtime';
import { EVENT_DELIVERY_JOB } from './event-delivery';
import { eventDeliveryDedupeKey } from '@storeweave/contracts';
import { DatabaseOperationTimeoutError, PermanentJobError, SYSTEM_ACTOR } from '@storeweave/contracts';
import { outboxEventInvalidReason } from './outbox-recovery';

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_DATABASE_TIMEOUT_MS = 5_000;
const DEFAULT_ABORT_GRACE_MS = 10_000;

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  outboxBatchSize?: number;
  staleLockSeconds?: number;
  workerId?: string;
  heartbeatIntervalMs?: number;
  databaseTimeoutMs?: number;
  abortGraceMs?: number;
}

export interface WorkerTickResult {
  recurringScheduled: number;
  recurringSkipped: number;
  recurringDeduped: number;
  recurringFailed: number;
  relayed: number;
  deliveriesEnqueued: number;
  jobsProcessed: number;
  jobsFailed: number;
}

export class WorkerFatalError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'WorkerFatalError';
  }
}

interface SettledHandler { readonly ok: boolean; readonly error?: unknown; }
interface ActiveJob {
  readonly claim: JobClaim;
  readonly controller: AbortController;
  readonly settled: Promise<SettledHandler>;
  readonly interrupted: Promise<Error>;
  readonly interrupt: (error: Error) => void;
  timer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  heartbeatRunning: boolean;
  heartbeatStopped: boolean;
  heartbeatPromise?: Promise<void>;
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * PostgreSQL worker with occurrence fencing. Timeout and shutdown abort the
 * cooperative signal then wait only a finite grace. An uncooperative handler,
 * or an uncertain heartbeat outcome, is fatal: the lease is left for recovery.
 */
export class Worker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly databaseTimeoutMs: number;
  private readonly abortGraceMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private readonly active = new Map<string, ActiveJob>();
  private fatalError: WorkerFatalError | undefined;
  private resolveFatal!: (error: WorkerFatalError) => void;
  private readonly fatalCompletion = new Promise<WorkerFatalError>(resolve => { this.resolveFatal = resolve; });

  constructor(private readonly runtime: Runtime, private readonly options: WorkerOptions = {}) {
    this.workerId = options.workerId ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
    const leaseSeconds = options.staleLockSeconds ?? runtime.config.worker.staleLockSeconds;
    this.leaseMs = leaseSeconds * 1_000;
    this.heartbeatMs = options.heartbeatIntervalMs ?? Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(this.leaseMs / 4));
    this.databaseTimeoutMs = options.databaseTimeoutMs ?? Math.min(DEFAULT_DATABASE_TIMEOUT_MS, Math.floor(this.heartbeatMs / 2));
    this.abortGraceMs = options.abortGraceMs ?? Math.min(DEFAULT_ABORT_GRACE_MS,
      Math.floor((this.leaseMs - this.heartbeatMs - this.databaseTimeoutMs) / 2));
    if (!Number.isSafeInteger(this.heartbeatMs) || !Number.isSafeInteger(this.databaseTimeoutMs)
      || !Number.isSafeInteger(this.abortGraceMs) || this.heartbeatMs <= 0 || this.databaseTimeoutMs <= 0 || this.abortGraceMs <= 0
      || this.databaseTimeoutMs >= this.heartbeatMs
      || this.heartbeatMs + this.databaseTimeoutMs + this.abortGraceMs >= this.leaseMs) {
      throw new Error(`Invalid worker timing: heartbeat=${this.heartbeatMs}ms database=${this.databaseTimeoutMs}ms grace=${this.abortGraceMs}ms lease=${this.leaseMs}ms`);
    }
  }

  get id(): string { return this.workerId; }
  /** Resolves exactly once when the process entrypoint must exit non-zero. */
  waitForFatal(): Promise<WorkerFatalError> { return this.fatalCompletion; }
  private throwIfFatal(): void { if (this.fatalError) throw this.fatalError; }

  private failStop(error: WorkerFatalError): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const active of this.active.values()) this.abort(active, error);
    this.runtime.logger.error({ workerId: this.workerId, error: error.message }, 'worker entered fatal state; leases are left for recovery');
    this.resolveFatal(error);
  }

  private abort(active: ActiveJob, error: Error): void {
    if (!active.controller.signal.aborted) active.controller.abort(error);
    active.interrupt(error);
  }

  private async database<T>(operation: string, fn: (tx: import('@storeweave/contracts').Tx) => Promise<T>): Promise<T> {
    return this.runtime.database.boundedTransaction(this.databaseTimeoutMs, operation, fn);
  }

  async relayOutbox(): Promise<{ relayed: number; enqueued: number }> {
    this.throwIfFatal();
    const batchSize = this.options.outboxBatchSize ?? this.runtime.config.worker.outboxBatchSize;
    let relayed = 0;
    let enqueued = 0;
    // Each event owns one transaction: a second enqueue failure rolls back the
    // first, while an invalid neighbour is quarantined without poisoning progress.
    for (let index = 0; index < batchSize; index += 1) {
      let claimedId: string | undefined;
      try {
        const result = await this.database('relay outbox event', async tx => {
          const row = await this.runtime.outbox.claimOne(tx);
          if (!row) return { kind: 'empty' as const, enqueued: 0 };
          claimedId = row.id;
          const snapshot = await this.snapshotForRelay(tx, row);
          if (!snapshot) {
            await this.runtime.outbox.quarantine(tx, row, 'legacy_subscriber_snapshot_unknown');
            return { kind: 'quarantined' as const, enqueued: 0 };
          }
          const event = toDomainEvent(row);
          const invalid = outboxEventInvalidReason(this.runtime.events, row);
          if (invalid) {
            await this.runtime.outbox.quarantine(tx, row, invalid);
            return { kind: 'quarantined' as const, enqueued: 0 };
          }
          let count = 0;
          for (const subscriberId of snapshot) {
            const subscription = this.runtime.events.subscribersFor(event.name).find(sub => sub.subscriberId === subscriberId);
            const enqueue = await this.runtime.jobs.enqueue(tx, {
              type: EVENT_DELIVERY_JOB, payload: { outboxId: event.id, subscriberId, event },
              dedupeKey: eventDeliveryDedupeKey(event.id, subscriberId), maxAttempts: subscription?.maxAttempts ?? 8,
            });
            if (!enqueue.deduped) count += 1;
          }
          await this.runtime.outbox.markRelayed(tx, event.id);
          return { kind: 'relayed' as const, enqueued: count };
        });
        if (result.kind === 'empty') break;
        if (result.kind === 'relayed') { relayed += 1; enqueued += result.enqueued; }
      } catch (error) {
        if (!claimedId) throw error;
        await this.runtime.outbox.recordTransientFailure(this.runtime.database.db, claimedId, (error as Error).message);
      }
    }
    return { relayed, enqueued };
  }

  private async snapshotForRelay(tx: import('@storeweave/contracts').Tx, row: import('@storeweave/outbox').OutboxRow): Promise<string[] | undefined> {
    return this.runtime.outbox.resolveSubscriberSnapshot(tx, row);
  }

  async runJobs(): Promise<{ processed: number; failed: number }> {
    this.assertReady();
    this.throwIfFatal();
    const limit = this.options.concurrency ?? this.runtime.config.worker.concurrency;
    const claimed = await this.database('claim jobs', tx => this.runtime.jobs.claim(
      tx, this.workerId, limit, undefined, this.leaseMs / 1_000, this.runtime.jobRegistry.claimConcurrencyPolicies(),
    ));
    if (claimed.length === 0) return { processed: 0, failed: 0 };
    const results = await Promise.all(claimed.map(job => this.runClaim(job)));
    this.throwIfFatal();
    return { processed: results.filter(result => result === 'processed').length, failed: results.filter(result => result === 'failed').length };
  }

  private async runClaim(job: JobClaim): Promise<'processed' | 'failed' | 'fatal'> {
    const logger = this.runtime.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    let handler;
    let payload: unknown;
    try {
      handler = this.runtime.jobRegistry.get(job.type);
      payload = this.runtime.jobRegistry.decode(job.type, job.payload, job.payload_version);
    } catch (error) {
      try {
        const result = await this.database('quarantine job payload', tx => this.runtime.jobs.quarantine(tx, job, (error as Error).message));
        if (result.applied) {
          logger.warn({ error: (error as Error).message, quarantined: true }, 'job payload quarantined');
          return 'failed';
        }
        this.failStop(new WorkerFatalError(`Lost fenced quarantine for ${job.id}`));
        return 'fatal';
      } catch (databaseError) {
        this.failStop(new WorkerFatalError('Could not establish quarantine outcome', databaseError));
        return 'fatal';
      }
    }

    const policy = this.runtime.jobRegistry.executionFor(job.type);
    const controller = new AbortController();
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<Error>(resolve => { interrupt = resolve; });
    const settled = Promise.resolve()
      .then(() => handler(payload, {
        logger, attempt: job.attempts, jobId: job.id,
        occurrenceId: job.occurrenceId, idempotencyKey: job.occurrenceId, signal: controller.signal,
        executeCommand: (name: string, input: unknown, idempotencyKey: string) => this.runtime.commands.execute(name, input, { actor: SYSTEM_ACTOR, idempotencyKey, channel: 'worker' }),
        executeQuery: (name: string, input: unknown) => this.runtime.queries.execute(name, input, { actor: SYSTEM_ACTOR, channel: 'worker' }),
      }))
      .then((): SettledHandler => ({ ok: true }), (error): SettledHandler => ({ ok: false, error }));
    const active: ActiveJob = { claim: job, controller, settled, interrupted, interrupt, heartbeatRunning: false, heartbeatStopped: false };
    this.active.set(job.claimToken, active);
    active.timer = setTimeout(() => this.abort(active, new Error(`Job handler timed out after ${policy.timeoutMs}ms`)), policy.timeoutMs);
    this.scheduleClaimHeartbeat(active);
    try {
      const outcome = await Promise.race([
        settled.then(result => ({ kind: 'settled' as const, result })),
        interrupted.then(error => ({ kind: 'interrupted' as const, error })),
      ]);
      if (outcome.kind === 'interrupted') {
        const result = await Promise.race([settled, delay(this.abortGraceMs).then(() => undefined)]);
        if (!result) {
          this.failStop(new WorkerFatalError(`Job ${job.id} did not settle within ${this.abortGraceMs}ms after abort`, outcome.error));
          return 'fatal';
        }
        if (this.fatalError) return 'fatal';
        return this.failClaim(job, outcome.error, logger, active);
      }
      if (this.fatalError) return 'fatal';
      if (!outcome.result.ok) {
        if (outcome.result.error instanceof JobQuarantineError) {
          const quarantineError = outcome.result.error;
          if (!await this.stopHeartbeatForTerminalMutation(active)) return 'fatal';
          try {
            const result = await this.database('quarantine delivery precondition', tx => this.runtime.jobs.quarantine(tx, job, quarantineError.reason));
            if (result.applied) return 'failed';
            this.failStop(new WorkerFatalError(`Lost fenced delivery quarantine for ${job.id}`));
            return 'fatal';
          } catch (databaseError) {
            this.failStop(new WorkerFatalError(`Could not establish delivery quarantine outcome for ${job.id}`, databaseError));
            return 'fatal';
          }
        }
        return this.failClaim(job, outcome.result.error, logger, active);
      }
      if (!await this.stopHeartbeatForTerminalMutation(active)) return 'fatal';
      try {
        const completion = await this.database('complete job', tx => this.runtime.jobs.complete(tx, job));
        if (completion.applied) return 'processed';
        this.failStop(new WorkerFatalError(`Lost fenced completion for ${job.id}`));
        return 'fatal';
      } catch (error) {
        this.failStop(new WorkerFatalError(`Could not establish completion outcome for ${job.id}`, error));
        return 'fatal';
      }
    } finally {
      if (active.timer) clearTimeout(active.timer);
      this.stopNewHeartbeats(active);
      this.active.delete(job.claimToken);
    }
  }

  private async failClaim(
    job: JobClaim, error: unknown, logger: import('@storeweave/contracts').Logger, active: ActiveJob,
  ): Promise<'failed' | 'fatal'> {
    if (!await this.stopHeartbeatForTerminalMutation(active)) return 'fatal';
    try {
      const result = await this.database('fail job', tx => this.runtime.jobs.fail(tx, job, (error as Error).message, error instanceof PermanentJobError));
      if (result.applied) {
        logger.warn({ error: (error as Error).message, outcome: result.outcome }, 'job failed');
        return 'failed';
      }
      this.failStop(new WorkerFatalError(`Lost fenced failure for ${job.id}`));
      return 'fatal';
    } catch (databaseError) {
      this.failStop(new WorkerFatalError(`Could not establish failure outcome for ${job.id}`, databaseError));
      return 'fatal';
    }
  }

  private scheduleClaimHeartbeat(active: ActiveJob): void {
    if (active.heartbeatStopped) return;
    active.heartbeatTimer = setTimeout(() => { void this.heartbeatClaim(active); }, this.heartbeatMs);
  }

  private stopNewHeartbeats(active: ActiveJob): void {
    active.heartbeatStopped = true;
    if (active.heartbeatTimer) clearTimeout(active.heartbeatTimer);
    active.heartbeatTimer = undefined;
  }

  /** A terminal ack cannot race a heartbeat that has begun but lacks an outcome. */
  private async stopHeartbeatForTerminalMutation(active: ActiveJob): Promise<boolean> {
    this.stopNewHeartbeats(active);
    if (active.heartbeatPromise) await active.heartbeatPromise;
    return !this.fatalError;
  }

  private async heartbeatClaim(active: ActiveJob): Promise<void> {
    if (!this.active.has(active.claim.claimToken) || this.fatalError || active.heartbeatStopped || active.heartbeatRunning) return;
    active.heartbeatRunning = true;
    const heartbeat = (async () => {
      const result = await this.database('heartbeat job lease', tx => this.runtime.jobs.heartbeat(tx, active.claim, this.leaseMs / 1_000));
      if (!result.applied) {
        this.failStop(new WorkerFatalError(`Lost fenced heartbeat for ${active.claim.jobId}`));
        return;
      }
      if (result.cancelRequested) {
        this.abort(active, new Error(`Job ${active.claim.jobId} cancellation requested`));
        return;
      }
      this.scheduleClaimHeartbeat(active);
    })().catch(error => {
      const message = error instanceof DatabaseOperationTimeoutError
        ? `Heartbeat database operation timed out for ${active.claim.jobId}`
        : `Heartbeat database operation failed for ${active.claim.jobId}`;
      this.failStop(new WorkerFatalError(message, error));
    });
    active.heartbeatPromise = heartbeat;
    try { await heartbeat; }
    finally {
      if (active.heartbeatPromise === heartbeat) active.heartbeatPromise = undefined;
      active.heartbeatRunning = false;
    }
  }

  private async heartbeat(): Promise<void> {
    await this.database('record worker heartbeat', tx => tx.execute(sql`
      INSERT INTO platform_worker_heartbeat (worker_id, version, updated_at)
      VALUES (${this.workerId}, ${this.runtime.platformVersion}, now())
      ON CONFLICT (worker_id) DO UPDATE SET updated_at = now(), version = EXCLUDED.version
    `).then(() => undefined));
  }

  async tick(): Promise<WorkerTickResult> {
    this.assertReady();
    this.throwIfFatal();
    await this.heartbeat();
    await this.database('reclaim stale jobs', tx => this.runtime.jobs.reclaimStale(tx));
    await this.database('cleanup expired jobs', tx => this.runtime.jobs.cleanupExpired(tx, this.runtime.config.worker.retentionCleanupBatchSize));
    // 排程跑在 worker 的 tick 裡，所以用 worker 自己的資料庫預算，而不是另一個獨立設定。
    const recurring = await this.runtime.recurring.ensureScheduled(new Date(), this.databaseTimeoutMs);
    const relay = await this.relayOutbox();
    const jobs = await this.runJobs();
    return { recurringScheduled: recurring.enqueued, recurringSkipped: recurring.skipped, recurringDeduped: recurring.deduped, recurringFailed: recurring.failed, relayed: relay.relayed, deliveriesEnqueued: relay.enqueued, jobsProcessed: jobs.processed, jobsFailed: jobs.failed };
  }

  async drain(maxRounds = 50): Promise<WorkerTickResult> {
    const total: WorkerTickResult = { recurringScheduled: 0, recurringSkipped: 0, recurringDeduped: 0, recurringFailed: 0, relayed: 0, deliveriesEnqueued: 0, jobsProcessed: 0, jobsFailed: 0 };
    for (let i = 0; i < maxRounds; i += 1) {
      const result = await this.tick();
      total.recurringScheduled += result.recurringScheduled;
      total.recurringSkipped += result.recurringSkipped;
      total.recurringDeduped += result.recurringDeduped;
      total.recurringFailed += result.recurringFailed;
      total.relayed += result.relayed;
      total.deliveriesEnqueued += result.deliveriesEnqueued;
      total.jobsProcessed += result.jobsProcessed;
      total.jobsFailed += result.jobsFailed;
      if (result.relayed === 0 && result.jobsProcessed === 0 && result.jobsFailed === 0) break;
    }
    return total;
  }

  start(): void {
    if (this.running) return;
    this.assertReady();
    this.throwIfFatal();
    this.running = true;
    const interval = this.options.pollIntervalMs ?? this.runtime.config.worker.pollIntervalMs;
    const loop = async () => {
      if (!this.running || this.fatalError) return;
      this.inFlight = this.tick().catch(error => {
        if (!this.fatalError) this.failStop(new WorkerFatalError('worker tick failed', error));
      });
      await this.inFlight;
      this.inFlight = null;
      if (this.running && !this.fatalError) this.timer = setTimeout(loop, interval);
    };
    this.runtime.logger.info({ workerId: this.workerId, interval }, 'worker started');
    void loop();
  }

  assertReady(): void { this.runtime.jobRegistry.assertPayloadDispatchReady(); }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const active of this.active.values()) this.abort(active, new Error('Worker shutdown requested'));
    if (this.inFlight) await this.inFlight;
    if (this.fatalError) throw this.fatalError;
    this.runtime.logger.info({ workerId: this.workerId }, 'worker stopped');
  }
}
