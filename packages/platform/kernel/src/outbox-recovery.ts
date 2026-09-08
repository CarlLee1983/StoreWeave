import { sql } from 'drizzle-orm';
import { eventDeliveryDedupeKey, EVENT_DELIVERY_JOB, PlatformError, type Tx } from '@storeweave/contracts';
import type { EventBus } from '@storeweave/event-bus';
import type { JobQueue } from '@storeweave/jobs';
import { asSubscriberSnapshot, normalizeSubscriberSnapshot, type OutboxRow, type OutboxStore } from '@storeweave/outbox';

export interface OutboxRecoveryInput {
  outboxId: string;
  subscriberIds: readonly string[];
  evidence: string;
  /** Only meaningful when repairing an unknown legacy snapshot to the empty set. */
  acknowledgeEmptyFanout?: boolean;
}

export interface OutboxRecoveryDeps {
  events: EventBus;
  jobs: JobQueue;
  outbox: OutboxStore;
}

/** Shared by worker recovery and the public operations command. */
export function outboxEventInvalidReason(events: EventBus, row: OutboxRow): string | undefined {
  let descriptor;
  try { descriptor = events.getEvent(row.event_name); }
  catch { return 'event_unknown'; }
  if (descriptor.version !== row.event_version) return 'event_version_invalid';
  return descriptor.payload.safeParse(row.payload).success ? undefined : 'event_payload_invalid';
}


/** A frozen snapshot is the only source of truth: the caller must reproduce it exactly. */
function resolveFrozenSnapshot(persisted: unknown, caller: readonly string[]): string[] {
  const stored = asSubscriberSnapshot(persisted);
  if (!stored) throw PlatformError.validation('Outbox redrive rejected: persisted subscriber snapshot is invalid');
  const frozen = normalizeSubscriberSnapshot(stored);
  if (frozen.length !== stored.length || frozen.some((id, index) => id !== stored[index])
    || frozen.length !== caller.length || frozen.some((id, index) => id !== caller[index])) {
    throw PlatformError.validation('Outbox redrive rejected: subscriber snapshot does not match persisted snapshot');
  }
  return frozen;
}

/**
 * Revalidates the frozen subscriber set before any state change. A relayed
 * event may have only a quarantined delivery job; an outbox event itself may
 * be quarantined; and a dead relay has no delivery job because fan-out rolls
 * back atomically. Each path retains durable evidence and records operator
 * provenance inside the same command transaction.
 */
export async function repairAndRedriveOutbox(
  tx: Tx, deps: OutboxRecoveryDeps, input: OutboxRecoveryInput,
): Promise<{ status: 'pending' | 'relayed' }> {
  if (!input.evidence.trim()) throw PlatformError.validation('Outbox redrive requires operator evidence');
  let callerSnapshot: string[];
  try { callerSnapshot = normalizeSubscriberSnapshot(input.subscriberIds); }
  catch (error) {
    // `details` is echoed to the caller for VALIDATION_ERROR, so the cause is attached to the
    // Error itself (for logs) rather than passed as details.
    throw Object.assign(PlatformError.validation((error as Error).message), { cause: error });
  }
  if (callerSnapshot.length !== input.subscriberIds.length
    || callerSnapshot.some((id, index) => id !== input.subscriberIds[index])) {
    throw PlatformError.validation('Outbox redrive rejected: subscriber snapshot must be sorted and deduplicated');
  }

  const result = await tx.execute<OutboxRow & { status: string }>(sql`
    SELECT id, event_name, event_version, payload, actor_id, correlation_id, occurred_at, attempts, subscriber_ids, status
    FROM platform_outbox WHERE id = ${input.outboxId} FOR UPDATE
  `);
  const row = result.rows[0];
  if (!row) throw PlatformError.notFound('Outbox event', input.outboxId);

  const invalid = outboxEventInvalidReason(deps.events, row);
  if (invalid) throw PlatformError.validation(`Outbox redrive rejected: ${invalid}`);
  const persistedSnapshot = row.subscriber_ids;
  const snapshot = persistedSnapshot === null ? callerSnapshot
    : resolveFrozenSnapshot(persistedSnapshot, callerSnapshot);
  for (const subscriberId of snapshot) {
    if (!deps.events.subscribersFor(row.event_name).some(sub => sub.subscriberId === subscriberId)) {
      throw PlatformError.conflict(`Outbox redrive rejected: subscriber_missing:${subscriberId}`);
    }
  }
  // The status is part of the precondition set, not of the write branches below: every
  // rejection must happen before the first repair or unquarantine, so that "nothing is
  // written until everything is validated" holds by reading, not by transaction rollback.
  if (row.status !== 'quarantined' && row.status !== 'dead' && row.status !== 'relayed') {
    throw PlatformError.conflict(`Outbox event ${row.id} cannot be redriven from ${row.status}`);
  }

  let deliveryRedriven = 0;
  if (persistedSnapshot === null) {
    if (snapshot.length === 0 && input.acknowledgeEmptyFanout !== true) {
      throw PlatformError.validation(
        'Outbox redrive rejected: repairing an unknown legacy snapshot to zero subscribers requires acknowledgeEmptyFanout',
      );
    }
    await deps.outbox.repairSubscriberSnapshotInTransaction(tx, input);
  }
  for (const subscriberId of snapshot) {
    const jobs = await tx.execute<{ id: string }>(sql`
      SELECT id FROM platform_jobs
      WHERE type = ${EVENT_DELIVERY_JOB} AND dedupe_key = ${eventDeliveryDedupeKey(row.id, subscriberId)}
        AND status = 'quarantined'
    `);
    for (const job of jobs.rows) {
      await deps.jobs.redriveQuarantined(tx, job.id);
      deliveryRedriven += 1;
    }
  }

  if (row.status === 'quarantined') {
    await deps.outbox.redriveQuarantinedInTransaction(tx, input);
    return { status: 'pending' };
  }
  if (row.status === 'dead') {
    await deps.outbox.retryDeadInTransaction(tx, input);
    return { status: 'pending' };
  }
  if (deliveryRedriven === 0) {
    throw PlatformError.conflict(`Outbox event ${row.id} has no quarantined delivery to redrive`);
  }
  await deps.outbox.auditDeliveryRedriveInTransaction(tx, input);
  return { status: 'relayed' };
}
