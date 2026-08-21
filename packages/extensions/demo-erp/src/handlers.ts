import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery } from '@storeweave/contracts';
import type {
  ErpProvider, ExtensionContext, ExtensionEventHandler, ExtensionJobHandler,
} from '@storeweave/extension-sdk';
import { PUSH_ORDER_JOB, type DemoErpConfig } from './config';
import { deliveryKey, deliveryRecord, erpReference, type DeliveryRecord } from './state';
import { toErpDocument, type PaidOrderEventPayload } from './transform';

const pushJobPayload = z.object({ orderId: z.string().uuid() });

/**
 * 訂閱 `commerce.order.paid.v1`。
 * 這裡只做「記錄 + 排入背景工作」；實際外部呼叫在工作裡，
 * 因此 ERP 掛掉不會影響核心訂單交易。
 */
export function createOrderPaidHandler(): ExtensionEventHandler<PaidOrderEventPayload> {
  return async (event, rawCtx) => {
    const ctx = rawCtx as ExtensionContext<DemoErpConfig>;
    const payload = event.payload;
    const key = deliveryKey(payload.orderId);

    const existing = await ctx.store.get<DeliveryRecord>(key);
    if (existing?.status === 'sent') {
      ctx.logger.info({ orderId: payload.orderId }, 'order already delivered to ERP; skipping');
      return;
    }

    const now = ctx.now().toISOString();
    const record: DeliveryRecord = existing ?? {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      reference: erpReference(payload.orderNumber),
      status: 'pending',
      attempts: 0,
      manualResends: 0,
      lastError: null,
      remoteId: null,
      jobId: null,
      firstSeenAt: now,
      updatedAt: now,
    };

    // dedupeKey 保證同一張訂單只會有一個推送工作，事件重送也不會多產生副作用
    const job = await ctx.jobs.enqueue({
      type: PUSH_ORDER_JOB,
      payload: { orderId: payload.orderId },
      dedupeKey: `ext.demo-erp:push:${payload.orderId}`,
      maxAttempts: ctx.config.maxAttempts,
    });

    await ctx.store.set(key, { ...record, jobId: job.deduped ? record.jobId : job.id, updatedAt: now });
    await ctx.store.set(`order-snapshot:${payload.orderId}`, payload);
  };
}

/** 背景工作：把訂單推到 ERP，並記錄成功／失敗／重試次數／最後錯誤。 */
export function createPushOrderJob(): ExtensionJobHandler {
  return async (rawPayload, ctx) => {
    const { orderId } = pushJobPayload.parse(rawPayload);
    const typedCtx = ctx as unknown as ExtensionContext<DemoErpConfig> & { attempt: number };
    const key = deliveryKey(orderId);
    const record = await typedCtx.store.get<DeliveryRecord>(key);
    if (!record) throw new Error(`No delivery record for order ${orderId}`);

    if (record.status === 'sent') {
      typedCtx.logger.info({ orderId }, 'delivery already marked sent; nothing to do');
      return;
    }

    const snapshot = await typedCtx.store.get<PaidOrderEventPayload>(`order-snapshot:${orderId}`);
    if (!snapshot) throw new Error(`No order snapshot for ${orderId}`);

    const document = toErpDocument(snapshot, typedCtx.config);
    const provider = typedCtx.getProvider<ErpProvider>('erp');
    const attempts = record.attempts + 1;

    try {
      const result = await provider.push(document);
      await typedCtx.store.set<DeliveryRecord>(key, {
        ...record,
        status: 'sent',
        attempts,
        remoteId: result.remoteId,
        lastError: null,
        updatedAt: typedCtx.now().toISOString(),
      });
      typedCtx.logger.info({ orderId, remoteId: result.remoteId, attempts }, 'order pushed to ERP');
    } catch (err) {
      const message = (err as Error).message;
      await typedCtx.store.set<DeliveryRecord>(key, {
        ...record,
        status: 'failed',
        attempts,
        lastError: message,
        updatedAt: typedCtx.now().toISOString(),
      });
      typedCtx.logger.warn({ orderId, attempts, error: message }, 'ERP push failed; will retry');
      throw err; // 交還給工作佇列做退避重試
    }
  };
}

export const resendOrderCommand = defineCommand({
  name: 'ext.demo-erp.resendOrder',
  summary: '人工重送訂單到 ERP',
  input: z.object({ orderId: z.string().uuid() }),
  output: z.object({ orderId: z.string(), status: z.string(), attempts: z.number().int(), jobId: z.string().nullable() }),
  permission: 'erp:write',
  idempotency: 'optional',
  audit: { action: 'erp.delivery.resent', resourceType: 'order', resourceId: (i) => i.orderId },
});

export function createResendHandler() {
  return async (input: { orderId: string }, rawCtx: any) => {
    const ctx = rawCtx as ExtensionContext<DemoErpConfig>;
    const key = deliveryKey(input.orderId);
    const record = await ctx.store.get<DeliveryRecord>(key);
    if (!record) throw PlatformError.notFound('ERP delivery', input.orderId);

    const now = ctx.now().toISOString();
    let jobId = record.jobId;
    if (jobId) {
      await ctx.jobs.requeue(jobId);
    } else {
      const job = await ctx.jobs.enqueue({
        type: PUSH_ORDER_JOB,
        payload: { orderId: input.orderId },
        dedupeKey: `ext.demo-erp:push:${input.orderId}`,
        maxAttempts: ctx.config.maxAttempts,
      });
      jobId = job.id;
    }

    await ctx.store.set<DeliveryRecord>(key, {
      ...record,
      status: record.status === 'sent' ? 'sent' : 'pending',
      manualResends: record.manualResends + 1,
      jobId,
      updatedAt: now,
    });

    return { orderId: input.orderId, status: record.status, attempts: record.attempts, jobId };
  };
}

export const listDeliveriesQuery = defineQuery({
  name: 'ext.demo-erp.listDeliveries',
  summary: '列出 ERP 投遞狀態',
  input: z.object({
    status: z.enum(['pending', 'sent', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ items: z.array(deliveryRecord) }),
  permission: 'erp:read',
});

export function createListDeliveriesHandler() {
  return async (input: { status?: string; limit: number }, rawCtx: any) => {
    const ctx = rawCtx as ExtensionContext<DemoErpConfig>;
    const entries = await ctx.store.list<DeliveryRecord>('delivery:', input.limit);
    const items = entries
      .map((e) => e.value)
      .filter((v) => (input.status ? v.status === input.status : true));
    return { items };
  };
}
