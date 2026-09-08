import { z } from 'zod';
import { PermanentJobError, PlatformError, defineCommand, defineQuery } from '@storeweave/contracts';
import type {
  ExtensionContext, ExtensionEventHandler, ExtensionJobHandler, ShippingProvider, ShippingShipmentInput, ShippingShipmentStatusInput,
} from '@storeweave/extension-sdk';
import {
  CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB, ECPAY_LOGISTICS_PROVIDER_ID,
  QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB, RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB,
  type EcpayLogisticsConfig,
} from './config';
import { EcpayLogisticsExternalGateError } from './provider';
import {
  operationKey, shipmentLifecycleStage, shipmentOperationDto, shipmentOperationRecord,
  type ShipmentOperationRecord,
} from './state';

export const shipmentIdInput = z.object({ shipmentId: z.string().uuid() }).strict();
const operationListInput = z.object({
  status: z.enum(['pending', 'created', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const operationListOutput = z.object({ items: z.array(shipmentOperationDto) });
export const recurringStatusPayload = z.object({
  bucket: z.number().int().nonnegative(),
  scheduledFor: z.string().datetime(),
}).strict();
const statusReconciliationCursor = z.object({ afterKey: z.string().nullable() });
const STATUS_RECONCILIATION_CURSOR_KEY = 'status-reconciliation-cursor';

/** Core validates this private projection; the extension depends only on the SDK carrier input contract. */
type CarrierShipmentRequest = ShippingShipmentInput & {
  readonly provider: string;
  readonly existingProviderRef: string | null;
  readonly existingTrackingNumber: string | null;
};
type CarrierShipmentStatusRequest = ShippingShipmentStatusInput & { readonly provider: string };

/**
 * Event delivery only reads the frozen carrier snapshot and schedules work.
 * No provider call happens on the outbox delivery transaction, and no delivery
 * PII is copied into the extension store or job payload.
 */
export function createShipmentCreatedHandler(): ExtensionEventHandler<{ shipmentId: string; orderId: string }> {
  return async (event, rawCtx) => {
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig>;
    const request = await carrierRequest(ctx, event.payload.shipmentId);
    if (request.provider !== ECPAY_LOGISTICS_PROVIDER_ID) return;

    const key = operationKey(request.shipmentId);
    const now = ctx.now().toISOString();
    let skippedExistingConsignment = false;
    // This is deliberately one atomic read/initialise transition. Two outbox
    // deliveries may overlap; neither may replace a worker's `created` state
    // with the pending snapshot it saw before the worker completed.
    const operation = await ctx.store.mutate<ShipmentOperationRecord>(key, (current) => {
      if (current?.status === 'created') return current;
      // Preserve the old manual/import path: if Shipping already carries a
      // provider reference, this event describes an existing consignment rather
      // than permission to create a second one remotely.
      if (request.existingProviderRef) {
        skippedExistingConsignment = true;
        return {
          shipmentId: request.shipmentId,
          orderId: request.orderId,
          reference: request.reference,
          status: 'created',
          attempts: current?.attempts ?? 0,
          manualRetries: current?.manualRetries ?? 0,
          lastError: null,
          providerRef: request.existingProviderRef,
          trackingNumber: request.existingTrackingNumber,
          labelAvailable: false,
          lastKnownStage: current?.lastKnownStage ?? 'created',
          lastStatusQueriedAt: current?.lastStatusQueriedAt ?? null,
          lastStatusQueryError: current?.lastStatusQueryError ?? null,
          jobId: current?.jobId ?? null,
          firstSeenAt: current?.firstSeenAt ?? now,
          updatedAt: now,
        };
      }
      return current ?? {
        shipmentId: request.shipmentId,
        orderId: request.orderId,
        reference: request.reference,
        status: 'pending',
        attempts: 0,
        manualRetries: 0,
        lastError: null,
        providerRef: null,
        trackingNumber: null,
        labelAvailable: false,
        lastKnownStage: 'created',
        lastStatusQueriedAt: null,
        lastStatusQueryError: null,
        jobId: null,
        firstSeenAt: now,
        updatedAt: now,
      };
    });
    if (operation.status === 'created') {
      if (skippedExistingConsignment) {
        ctx.logger.info({ shipmentId: request.shipmentId, providerRef: request.existingProviderRef }, 'ECPay logistics shipment already recorded; skipping carrier create');
      }
      return;
    }
    const job = await ctx.jobs.enqueue({
      type: CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB,
      payload: { shipmentId: request.shipmentId },
      dedupeKey: createDedupeKey(request.shipmentId),
      maxAttempts: ctx.config.maxAttempts,
    });
    await ctx.store.mutate<ShipmentOperationRecord>(key, (current) => {
      const latest = current ?? operation;
      // A fast worker may have completed while enqueue() returned. Its result
      // is authoritative; never turn it back into a pending operation.
      if (latest.status === 'created') return latest;
      return {
        ...latest,
        jobId: job.deduped ? latest.jobId : job.id,
        updatedAt: ctx.now().toISOString(),
      };
    });
  };
}

/** External I/O is isolated to this job and is replay-safe through `reference`. */
export function createEcpayLogisticsShipmentJob(): ExtensionJobHandler {
  return async (rawPayload, rawCtx) => {
    const { shipmentId } = shipmentIdInput.parse(rawPayload);
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig> & { attempt: number; jobId: string };
    const key = operationKey(shipmentId);
    const existing = await ctx.store.get<ShipmentOperationRecord>(key);
    if (existing?.status === 'created') return;

    const request = await carrierRequest(ctx, shipmentId);
    // `enqueue()` and extension-store writes are deliberately separate short
    // transactions. If a process dies after enqueue but before the state write,
    // the durable job rebuilds its PII-free operational record from Shipping.
    const record: ShipmentOperationRecord = existing ?? {
      shipmentId: request.shipmentId,
      orderId: request.orderId,
      reference: request.reference,
      status: 'pending',
      attempts: 0,
      manualRetries: 0,
      lastError: null,
      providerRef: null,
      trackingNumber: null,
      labelAvailable: false,
      lastKnownStage: 'created',
      lastStatusQueriedAt: null,
      lastStatusQueryError: null,
      jobId: ctx.jobId,
      firstSeenAt: ctx.now().toISOString(),
      updatedAt: ctx.now().toISOString(),
    };
    if (!existing) {
      await ctx.store.set(key, record);
    }
    if (request.provider !== ECPAY_LOGISTICS_PROVIDER_ID || request.reference !== record.reference) {
      throw new PermanentJobError(`Shipment ${shipmentId} no longer matches its ECPay logistics operation`);
    }
    const attempts = record.attempts + 1;
    const provider = ctx.getProvider<ShippingProvider>('shipping', ECPAY_LOGISTICS_PROVIDER_ID);

    try {
      const result = await provider.createShipment(request);
      await ctx.commands.execute('commerce.shipping.recordProviderShipment', {
        shipmentId,
        provider: ECPAY_LOGISTICS_PROVIDER_ID,
        reference: request.reference,
        providerRef: result.providerRef,
        ...(result.trackingNumber ? { trackingNumber: result.trackingNumber } : {}),
        ...(result.label ? { labelReference: result.label.reference } : {}),
      }, { idempotencyKey: `shipping:provider-result:${shipmentId}:${request.reference}` });

      await ctx.store.set(key, {
        ...record,
        status: 'created',
        attempts,
        lastError: null,
        providerRef: result.providerRef,
        trackingNumber: result.trackingNumber ?? null,
        labelAvailable: Boolean(result.label),
        jobId: ctx.jobId,
        updatedAt: ctx.now().toISOString(),
      });
      ctx.logger.info({ shipmentId, providerRef: result.providerRef, attempts }, 'ECPay logistics shipment recorded');
    } catch (err) {
      const message = safeOperationError(err);
      await ctx.store.set(key, {
        ...record,
        status: 'failed',
        attempts,
        lastError: message,
        jobId: ctx.jobId,
        updatedAt: ctx.now().toISOString(),
      });
      ctx.logger.warn({ shipmentId, attempts }, 'ECPay logistics shipment create failed');
      if (err instanceof EcpayLogisticsExternalGateError) throw new PermanentJobError(message);
      throw new Error(message);
    }
  };
}

/**
 * Periodically fans a bounded scan into per-shipment jobs. The recurring
 * scheduler owns occurrence de-duplication; each child key is unique to that
 * occurrence, so a completed query never prevents the next reconciliation.
 */
export function createEcpayLogisticsStatusReconciliationJob(): ExtensionJobHandler {
  return async (rawPayload, rawCtx) => {
    const payload = recurringStatusPayload.parse(rawPayload);
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig>;
    // The currently supported live transport is explicitly gated. Do not turn
    // every scheduled occurrence into dead jobs while merchant UAT is pending.
    if (ctx.config.mode !== 'fake') {
      ctx.logger.info({ bucket: payload.bucket }, 'ECPay logistics status reconciliation awaits live transport UAT');
      return;
    }
    const cursor = statusReconciliationCursor.parse(
      (await ctx.store.get<unknown>(STATUS_RECONCILIATION_CURSOR_KEY)) ?? { afterKey: null },
    );
    // The cursor is by immutable key, not updatedAt: every successful query
    // updates the record, so recency ordering would starve older shipments.
    let entries = await ctx.store.list<unknown>('shipment-operation:', ctx.config.statusQueryBatchSize, cursor.afterKey ?? undefined);
    if (entries.length === 0 && cursor.afterKey !== null) {
      entries = await ctx.store.list<unknown>('shipment-operation:', ctx.config.statusQueryBatchSize);
    }
    if (entries.length > 0) {
      await ctx.store.set(STATUS_RECONCILIATION_CURSOR_KEY, { afterKey: entries.at(-1)!.key });
    }
    const operations = entries
      .map((entry) => shipmentOperationRecord.safeParse(entry.value))
      .flatMap((parsed) => parsed.success ? [parsed.data] : [])
      .filter((operation) => operation.status === 'created' && operation.providerRef && operation.lastKnownStage !== 'completed');
    for (const operation of operations) {
      await ctx.jobs.enqueue({
        type: QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB,
        payload: { shipmentId: operation.shipmentId },
        dedupeKey: `${QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB}:${operation.shipmentId}:${payload.bucket}`,
        maxAttempts: ctx.config.maxAttempts,
      });
    }
  };
}

/** External status I/O stays in a retryable job and never receives delivery PII. */
export function createEcpayLogisticsStatusQueryJob(): ExtensionJobHandler {
  return async (rawPayload, rawCtx) => {
    const { shipmentId } = shipmentIdInput.parse(rawPayload);
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig> & { attempt: number; jobId: string };
    const key = operationKey(shipmentId);
    const operation = await ctx.store.get<ShipmentOperationRecord>(key);
    if (!operation || operation.status !== 'created' || operation.lastKnownStage === 'completed') return;

    const request = await carrierStatusRequest(ctx, shipmentId);
    if (request.provider !== ECPAY_LOGISTICS_PROVIDER_ID) {
      throw new PermanentJobError(`Shipment ${shipmentId} no longer matches its ECPay logistics operation`);
    }
    const provider = ctx.getProvider<ShippingProvider>('shipping', ECPAY_LOGISTICS_PROVIDER_ID);
    if (!provider.queryShipmentStatus) {
      throw new PermanentJobError('ECPay logistics provider does not support shipment status queries');
    }
    try {
      const result = await provider.queryShipmentStatus(request);
      const stage = result.stage ? shipmentLifecycleStage.parse(result.stage) : undefined;
      const shipment = await ctx.commands.execute<{ status: 'created' | 'shipped' | 'arrived' | 'completed' }>('commerce.shipping.recordProviderStatus', {
        shipmentId,
        provider: ECPAY_LOGISTICS_PROVIDER_ID,
        rawStatus: result.rawStatus,
        ...(stage ? { stage } : {}),
      }, { idempotencyKey: `shipping:provider-status:${shipmentId}:${ctx.jobId}` });
      await ctx.store.mutate<ShipmentOperationRecord>(key, (current) => {
        const latest = current ?? operation;
        return {
          ...latest,
          // Core enforces the source of truth and returns its monotonic stage,
          // so a delayed provider response cannot regress extension state.
          lastKnownStage: shipment.status,
          lastStatusQueriedAt: ctx.now().toISOString(),
          lastStatusQueryError: null,
          updatedAt: ctx.now().toISOString(),
        };
      });
      ctx.logger.info({ shipmentId, stage: stage ?? null }, 'ECPay logistics shipment status reconciled');
    } catch (err) {
      const message = safeStatusQueryError(err);
      await ctx.store.mutate<ShipmentOperationRecord>(key, (current) => {
        const latest = current ?? operation;
        return { ...latest, lastStatusQueryError: message, updatedAt: ctx.now().toISOString() };
      });
      ctx.logger.warn({ shipmentId }, 'ECPay logistics shipment status query failed');
      if (err instanceof EcpayLogisticsExternalGateError) throw new PermanentJobError(message);
      throw new Error(message);
    }
  };
}

export const retryShipmentCommand = defineCommand({
  name: 'ext.ecpay-logistics.retryShipment',
  summary: '重送死信中的綠界物流建單',
  input: shipmentIdInput,
  output: shipmentOperationDto,
  permission: 'ecpay-logistics:write',
  idempotency: 'optional',
  audit: { action: 'ecpay_logistics.shipment.retried', resourceType: 'shipment', resourceId: (input) => input.shipmentId },
});

export function createRetryShipmentHandler() {
  return async (input: z.infer<typeof shipmentIdInput>, rawCtx: any) => {
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig>;
    const key = operationKey(input.shipmentId);
    const record = await ctx.store.get<ShipmentOperationRecord>(key);
    if (!record) throw PlatformError.notFound('ECPay logistics operation', input.shipmentId);
    if (record.status !== 'failed' || !record.jobId) {
      throw PlatformError.conflict(`Shipment ${input.shipmentId} is not a retryable failed ECPay logistics operation`);
    }
    // Only a dead job can be manually retried. A merely failed operation may
    // still have a scheduled automatic retry; requeueing it would permit two
    // workers to race the same carrier create request.
    await ctx.jobs.retryDead(record.jobId);
    const updated = await ctx.store.mutate<ShipmentOperationRecord>(key, (current) => {
      const latest = current ?? record;
      // A worker may have run immediately after retryDead(). Preserve its
      // terminal/failed state rather than replacing it with stale pending UI.
      if (latest.status === 'created' || latest.attempts > record.attempts) {
        return { ...latest, manualRetries: latest.manualRetries + 1 };
      }
      return {
        ...latest,
        status: 'pending',
        manualRetries: latest.manualRetries + 1,
        lastError: null,
        updatedAt: ctx.now().toISOString(),
      };
    });
    return shipmentOperationDto.parse(updated);
  };
}

export const getShipmentOperationQuery = defineQuery({
  name: 'ext.ecpay-logistics.getShipmentOperation',
  summary: '取得綠界物流建單營運狀態',
  input: shipmentIdInput,
  output: shipmentOperationDto.nullable(),
  permission: 'ecpay-logistics:read',
});

export function createGetShipmentOperationHandler() {
  return async (input: z.infer<typeof shipmentIdInput>, rawCtx: any) => {
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig>;
    const record = await ctx.store.get<ShipmentOperationRecord>(operationKey(input.shipmentId));
    return record ? shipmentOperationDto.parse(record) : null;
  };
}

export const listShipmentOperationsQuery = defineQuery({
  name: 'ext.ecpay-logistics.listShipmentOperations',
  summary: '列出綠界物流建單營運狀態',
  input: operationListInput,
  output: operationListOutput,
  permission: 'ecpay-logistics:read',
});

export function createListShipmentOperationsHandler() {
  return async (input: z.infer<typeof operationListInput>, rawCtx: any) => {
    const ctx = rawCtx as ExtensionContext<EcpayLogisticsConfig>;
    // Filter before applying the caller's page limit. ExtensionStore has no
    // predicate query, so keep this bounded operational scan deliberately
    // larger than one response page instead of hiding older failed records.
    const entries = await ctx.store.list<ShipmentOperationRecord>('shipment-operation:', 10_000);
    return {
      items: entries
        .map((entry) => shipmentOperationDto.parse(entry.value))
        .filter((entry) => input.status ? entry.status === input.status : true)
        .slice(0, input.limit),
    };
  };
}

function createDedupeKey(shipmentId: string): string {
  return `ext.ecpay-logistics:create:${shipmentId}`;
}

async function carrierRequest(ctx: ExtensionContext<EcpayLogisticsConfig>, shipmentId: string): Promise<CarrierShipmentRequest> {
  return ctx.queries.execute<CarrierShipmentRequest>('commerce.shipping.getProviderShipmentRequest', { id: shipmentId });
}

async function carrierStatusRequest(
  ctx: ExtensionContext<EcpayLogisticsConfig>, shipmentId: string,
): Promise<CarrierShipmentStatusRequest> {
  return ctx.queries.execute<CarrierShipmentStatusRequest>('commerce.shipping.getProviderShipmentStatusRequest', { id: shipmentId });
}

/** Never persist or rethrow raw upstream errors; later live code must map errors to safe operational messages. */
function safeOperationError(err: unknown): string {
  if (err instanceof EcpayLogisticsExternalGateError) return err.message;
  if (err instanceof Error && err.message.startsWith('simulated ECPay logistics timeout')) return err.message;
  if (err instanceof Error && err.message.startsWith('ECPay logistics adapter currently supports')) return err.message;
  if (err instanceof Error && err.message.startsWith('ECPay logistics service type is not enabled')) return err.message;
  return 'carrier create request failed';
}

function safeStatusQueryError(err: unknown): string {
  if (err instanceof EcpayLogisticsExternalGateError) return err.message;
  if (err instanceof Error && err.message.startsWith('fake ECPay logistics shipment was not found')) return err.message;
  return 'carrier status query failed';
}
