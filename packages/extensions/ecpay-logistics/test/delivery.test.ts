import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestExtensionContext, type ShippingProvider } from '@storeweave/extension-sdk';
import type { ProviderShipmentRequestDto, ProviderShipmentStatusRequestDto } from '@storeweave/shipping';
import {
  createEcpayLogisticsProvider, ecpayLogisticsConfig, ecpayLogisticsExtension,
  operationKey, type ShipmentOperationRecord,
} from '@storeweave/ext-ecpay-logistics';

const secrets = {
  ECPAY_LOGISTICS_MERCHANT_ID: 'test-merchant-id',
  ECPAY_LOGISTICS_HASH_KEY: 'test-hash-key',
  ECPAY_LOGISTICS_HASH_IV: 'test-hash-iv',
};

const request: ProviderShipmentRequestDto = {
  shipmentId: '11111111-1111-4111-8111-111111111111',
  orderId: '22222222-2222-4222-8222-222222222222',
  provider: 'ecpay-logistics',
  serviceCode: 'ecpay-home',
  serviceType: 'home_delivery',
  reference: 'shipment:11111111-1111-4111-8111-111111111111',
  destination: {
    kind: 'taiwan_home', countryCode: 'TW', recipient: '測試收件人', phone: '0912345678',
    postcode: '100', city: '台北市', district: '中正區', line1: '測試路 1 號', line2: null,
  },
  existingProviderRef: null,
  existingTrackingNumber: null,
};

const shipmentCreated = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'commerce.shipment.created.v1',
  version: 1,
  occurredAt: new Date('2026-08-24T00:00:00.000Z'),
  actorId: 'test:admin',
  correlationId: 'corr-1',
  payload: { shipmentId: request.shipmentId, orderId: request.orderId },
};

async function setup(
  config: Record<string, unknown> = {},
  options: { request?: ProviderShipmentRequestDto; failCoreWriteOnce?: boolean } = {},
) {
  let failCoreWriteOnce = options.failCoreWriteOnce ?? false;
  let providerRef: string | null = null;
  const ctx = createTestExtensionContext({
    extensionId: 'ecpay-logistics',
    config: ecpayLogisticsConfig.parse({ mode: 'fake', ...config }),
    secrets,
    queries: {
      'commerce.shipping.getProviderShipmentRequest': async () => options.request ?? request,
      'commerce.shipping.getProviderShipmentStatusRequest': async () => ({
        shipmentId: (options.request ?? request).shipmentId,
        provider: (options.request ?? request).provider,
        reference: (options.request ?? request).reference,
        providerRef: providerRef ?? 'ECPAY-NOT-CREATED',
        trackingNumber: null,
      } satisfies ProviderShipmentStatusRequestDto),
    },
    commands: {
      'commerce.shipping.recordProviderShipment': async (input) => {
        if (failCoreWriteOnce) {
          failCoreWriteOnce = false;
          throw new Error('database failure that must not expose ECPAY_LOGISTICS_HASH_KEY=test-hash-key');
        }
        providerRef = (input as { providerRef: string }).providerRef;
        return input;
      },
      'commerce.shipping.recordProviderStatus': async (input) => ({
        status: (input as { stage?: 'shipped' | 'arrived' | 'completed' }).stage ?? 'created',
      }),
    },
  });
  const registration = await ecpayLogisticsExtension.setup(ctx);
  // Providers are registered by the extension; wire the test context back to it.
  (ctx as any).getProvider = () => registration.providers![0];
  const jobHandlers = Object.fromEntries((registration.jobs ?? []).map((job) => [job.type, job.handler]));
  return { ctx, registration, jobHandlers };
}

describe('ECPay logistics carrier adapter', () => {
  it('parses only signed fake callbacks into normalized evidence and keeps live callback support gated', async () => {
    const { registration } = await setup();
    const provider = registration.providers![0]! as ShippingProvider;
    const fields = {
      providerRef: 'ECPAY-FAKE-1', rawStatus: 'fake_arrived', stage: 'arrived', callbackId: 'fake-event-1',
      trackingUrl: 'https://carrier.example.test/track/ECPAY-FAKE-1',
    };
    const canonical = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))).toString();
    const signature = createHash('sha256').update(`fake-ecpay-logistics:${secrets.ECPAY_LOGISTICS_HASH_KEY}:${canonical}`).digest('hex');
    const body = new TextEncoder().encode(new URLSearchParams({ ...fields, signature }).toString());

    await expect(provider.parseCallback!({ body, headers: {}, query: {} })).resolves.toEqual({
      providerRef: fields.providerRef, rawStatus: fields.rawStatus, stage: 'arrived', callbackId: fields.callbackId, trackingUrl: fields.trackingUrl,
    });
    await expect(provider.parseCallback!({ body: new TextEncoder().encode('providerRef=x'), headers: {}, query: {} })).rejects.toThrow(/signature/);

    const gated = createEcpayLogisticsProvider(createTestExtensionContext({
      extensionId: 'ecpay-logistics', config: ecpayLogisticsConfig.parse({ mode: 'external_gate' }), secrets,
    }));
    await expect(gated.parseCallback!({ body, headers: {}, query: {} })).rejects.toThrow(/UAT/);
  });

  it('requires secrets, rejects credentials in config, and reports the live transport gate honestly', async () => {
    const config = ecpayLogisticsConfig.parse({});
    expect(() => createEcpayLogisticsProvider(createTestExtensionContext({
      extensionId: 'ecpay-logistics', config,
    }))).toThrow(/required secrets/);
    expect(() => ecpayLogisticsConfig.parse({ merchantId: 'must-not-be-in-yaml' })).toThrow(/unrecognized/i);
    expect((await setup({ mode: 'external_gate' })).registration).toBeDefined();

    const gated = createEcpayLogisticsProvider(createTestExtensionContext({
      extensionId: 'ecpay-logistics', config, secrets,
    }));
    await expect(gated.healthCheck!()).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/gated/i) });
  });

  it('event delivery schedules a deduped job without performing the carrier call', async () => {
    const { ctx, registration } = await setup();
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await registration.events![0].handler(shipmentCreated as any, ctx);

    expect(ctx.calls.commands).toEqual([]);
    expect(ctx.calls.jobs).toHaveLength(2);
    expect(new Set(ctx.calls.jobs.map((job) => job.dedupeKey))).toEqual(new Set([
      `ext.ecpay-logistics:create:${request.shipmentId}`,
    ]));
  });

  it('does not overwrite a fast worker result with the event handler pending snapshot', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    const enqueue = ctx.jobs.enqueue.bind(ctx.jobs);
    (ctx.jobs as any).enqueue = async (input: any) => {
      const job = await enqueue(input);
      await jobHandlers[input.type]!(input.payload, { ...ctx, attempt: 1, jobId: job.id } as any);
      return job;
    };

    await registration.events![0].handler(shipmentCreated as any, ctx);

    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'created', attempts: 1, providerRef: expect.stringMatching(/^ECPAY-/),
    });
  });

  it('keeps a completed operation completed when two duplicate event deliveries overlap', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    const enqueue = ctx.jobs.enqueue.bind(ctx.jobs);
    (ctx.jobs as any).enqueue = async (input: any) => {
      const job = await enqueue(input);
      if (!job.deduped) {
        await jobHandlers[input.type]!(input.payload, { ...ctx, attempt: 1, jobId: job.id } as any);
      }
      return job;
    };

    await Promise.all([
      registration.events![0].handler(shipmentCreated as any, ctx),
      registration.events![0].handler(shipmentCreated as any, ctx),
    ]);

    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'created', attempts: 1, providerRef: expect.stringMatching(/^ECPAY-/),
    });
    expect(ctx.calls.commands).toHaveLength(1);
  });

  it('persists normalized shipment evidence after the background fake carrier succeeds without copying destination data to state', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await ctx.drainJobs(jobHandlers as any);

    expect(ctx.calls.commands).toEqual([{
      name: 'commerce.shipping.recordProviderShipment',
      input: {
        shipmentId: request.shipmentId, provider: 'ecpay-logistics', reference: request.reference,
        providerRef: expect.stringMatching(/^ECPAY-/), trackingNumber: expect.stringMatching(/^TW-/),
        labelReference: expect.stringMatching(/^LABEL-/),
      },
      idempotencyKey: `shipping:provider-result:${request.shipmentId}:${request.reference}`,
    }]);
    const record = await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId));
    expect(record).toMatchObject({ status: 'created', attempts: 1, labelAvailable: true, lastError: null });
    expect(JSON.stringify(record)).not.toContain('測試收件人');
    expect(JSON.stringify(record)).not.toContain('台北市');

    const operation = await registration.queries!.find((query) => query.descriptor.name === 'ext.ecpay-logistics.getShipmentOperation')!
      .handler({ shipmentId: request.shipmentId }, ctx as any);
    expect(operation).not.toHaveProperty('reference');
  });

  it('proactively queries a created shipment without reading destination data, then records only normalized status evidence', async () => {
    const { ctx, registration, jobHandlers } = await setup({ fakeQueryStage: 'arrived' });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await ctx.drainJobs(jobHandlers as any);

    await jobHandlers['ext.ecpay-logistics.query-shipment-status']!(
      { shipmentId: request.shipmentId }, { ...ctx, attempt: 1, jobId: 'status-job-1' } as any,
    );

    expect(ctx.calls.queries.map((call) => call.name)).toContain('commerce.shipping.getProviderShipmentStatusRequest');
    expect(ctx.calls.commands).toContainEqual({
      name: 'commerce.shipping.recordProviderStatus',
      input: { shipmentId: request.shipmentId, provider: 'ecpay-logistics', rawStatus: 'fake_arrived', stage: 'arrived' },
      idempotencyKey: `shipping:provider-status:${request.shipmentId}:status-job-1`,
    });
    const record = await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId));
    expect(record).toMatchObject({ lastKnownStage: 'arrived', lastStatusQueryError: null });
    expect(record!.lastStatusQueriedAt).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain('測試收件人');
  });

  it('recurring reconciliation enqueues a bounded, per-occurrence status query and stops after completion', async () => {
    const { ctx, registration, jobHandlers } = await setup({ fakeQueryStage: 'completed', statusQueryBatchSize: 1 });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await ctx.drainJobs(jobHandlers as any);

    await jobHandlers['ext.ecpay-logistics.reconcile-shipment-statuses']!(
      { bucket: 123, scheduledFor: '2026-08-24T00:00:00.000Z' }, ctx as any,
    );
    expect(ctx.calls.jobs).toContainEqual({
      type: 'ext.ecpay-logistics.query-shipment-status', payload: { shipmentId: request.shipmentId },
      dedupeKey: `ext.ecpay-logistics.query-shipment-status:${request.shipmentId}:123`,
    });
    await ctx.drainJobs(jobHandlers as any);

    const before = ctx.calls.jobs.length;
    await jobHandlers['ext.ecpay-logistics.reconcile-shipment-statuses']!(
      { bucket: 124, scheduledFor: '2026-08-24T00:30:00.000Z' }, ctx as any,
    );
    expect(ctx.calls.jobs).toHaveLength(before);
  });

  it('rotates the reconciliation cursor so a busy shipment cannot starve later shipments', async () => {
    const { ctx, jobHandlers } = await setup({ statusQueryBatchSize: 1 });
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    for (const shipmentId of ids) {
      await ctx.store.set(operationKey(shipmentId), {
        shipmentId, orderId: request.orderId, reference: `shipment:${shipmentId}`, status: 'created',
        attempts: 1, manualRetries: 0, lastError: null, providerRef: `ECPAY-${shipmentId}`,
        trackingNumber: null, labelAvailable: false, lastKnownStage: 'created',
        lastStatusQueriedAt: null, lastStatusQueryError: null, jobId: `job-${shipmentId}`,
        firstSeenAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      } satisfies ShipmentOperationRecord);
    }

    const reconcile = jobHandlers['ext.ecpay-logistics.reconcile-shipment-statuses']!;
    await reconcile({ bucket: 1, scheduledFor: '2026-08-24T00:00:00.000Z' }, ctx as any);
    await reconcile({ bucket: 2, scheduledFor: '2026-08-24T00:30:00.000Z' }, ctx as any);

    expect(ctx.calls.jobs.map((job) => job.payload)).toEqual(ids.map((shipmentId) => ({ shipmentId })));
  });

  it('reconciles an ambiguous post-create timeout on the same reference and records exactly one fake remote shipment', async () => {
    const { ctx, registration, jobHandlers } = await setup({ fakeTimeoutsAfterCreate: 1 });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    const job = jobHandlers['ext.ecpay-logistics.create-shipment'];

    await expect(job!({ shipmentId: request.shipmentId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any)).rejects.toThrow(/simulated ECPay logistics timeout/);
    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'failed', attempts: 1, lastError: expect.stringMatching(/timeout/),
    });
    expect(ctx.calls.commands).toEqual([]);

    await job!({ shipmentId: request.shipmentId }, { ...ctx, attempt: 2, jobId: 'job-1' } as any);
    const remote = await ctx.store.list<any>('fake-remote:');
    expect(remote).toHaveLength(1);
    expect(remote[0]!.value.result.providerRef).toMatch(/^ECPAY-/);
    expect(ctx.calls.commands).toHaveLength(1);
    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'created', attempts: 2,
    });
  });

  it('makes a failed operation visible and lets an authorised operator request a dead-letter retry', async () => {
    const { ctx, registration, jobHandlers } = await setup({ fakeTimeoutsAfterCreate: 1 });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await expect(jobHandlers['ext.ecpay-logistics.create-shipment']!(
      { shipmentId: request.shipmentId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any,
    )).rejects.toThrow(/timeout/);

    const retry = registration.commands!.find((command) => command.descriptor.name === 'ext.ecpay-logistics.retryShipment')!;
    const retried = await retry.handler({ shipmentId: request.shipmentId }, ctx as any);
    expect(retried).toMatchObject({ shipmentId: request.shipmentId, status: 'pending', manualRetries: 1, lastError: null });
    expect(retried).not.toHaveProperty('reference');
  });

  it('replays the carrier result after a core-result write failure without leaking the original error', async () => {
    const { ctx, registration, jobHandlers } = await setup({}, { failCoreWriteOnce: true });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    const job = jobHandlers['ext.ecpay-logistics.create-shipment'];

    await expect(job!({ shipmentId: request.shipmentId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any)).rejects.toThrow('carrier create request failed');
    const failed = await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId));
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'carrier create request failed' });
    expect(JSON.stringify(failed)).not.toContain('test-hash-key');

    await job!({ shipmentId: request.shipmentId }, { ...ctx, attempt: 2, jobId: 'job-1' } as any);
    expect(await ctx.store.list('fake-remote:')).toHaveLength(1);
    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({ status: 'created', attempts: 2 });
  });

  it('rebuilds its operational record when a process dies after enqueue but before state persistence', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(shipmentCreated as any, ctx);
    await ctx.store.delete(operationKey(request.shipmentId));

    await jobHandlers['ext.ecpay-logistics.create-shipment']!(
      { shipmentId: request.shipmentId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any,
    );
    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'created', attempts: 1, jobId: 'job-1',
    });
    expect(ctx.calls.commands).toHaveLength(1);
  });

  it('ignores shipments owned by another carrier', async () => {
    const other = { ...request, provider: 'manual' };
    const { ctx, registration } = await setup({}, { request: other });
    await registration.events![0].handler(shipmentCreated as any, ctx);
    expect(ctx.calls.jobs).toEqual([]);
    expect(await ctx.store.get(operationKey(request.shipmentId))).toBeNull();
  });

  it('does not create a second remote consignment for an imported shipment that already has provider evidence', async () => {
    const imported = { ...request, existingProviderRef: 'IMPORTED-ECPAY-1', existingTrackingNumber: 'IMPORTED-TW-1' };
    const { ctx, registration } = await setup({}, { request: imported });
    await registration.events![0].handler(shipmentCreated as any, ctx);

    expect(ctx.calls.jobs).toEqual([]);
    expect(await ctx.store.get<ShipmentOperationRecord>(operationKey(request.shipmentId))).toMatchObject({
      status: 'created', providerRef: 'IMPORTED-ECPAY-1', trackingNumber: 'IMPORTED-TW-1', labelAvailable: false,
    });
  });

  it('filters operation status before applying the response limit so older failures remain visible', async () => {
    const { ctx, registration } = await setup();
    for (let index = 0; index < 51; index += 1) {
      const shipmentId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await ctx.store.set(operationKey(shipmentId), {
        shipmentId, orderId: request.orderId, reference: `shipment:${shipmentId}`, status: 'created',
        attempts: 1, manualRetries: 0, lastError: null, providerRef: `ECPAY-${index}`,
        trackingNumber: null, labelAvailable: false, jobId: `job-${index}`,
        lastKnownStage: 'created', lastStatusQueriedAt: null, lastStatusQueryError: null,
        firstSeenAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      } satisfies ShipmentOperationRecord);
    }
    const failedId = '99999999-9999-4999-8999-999999999999';
    await ctx.store.set(operationKey(failedId), {
      shipmentId: failedId, orderId: request.orderId, reference: `shipment:${failedId}`, status: 'failed',
      attempts: 2, manualRetries: 0, lastError: 'timeout', providerRef: null,
      trackingNumber: null, labelAvailable: false, jobId: 'job-failed',
      lastKnownStage: 'created', lastStatusQueriedAt: null, lastStatusQueryError: null,
      firstSeenAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    } satisfies ShipmentOperationRecord);

    const list = await registration.queries!.find((query) => query.descriptor.name === 'ext.ecpay-logistics.listShipmentOperations')!
      .handler({ status: 'failed', limit: 1 }, ctx as any);
    expect(list.items).toEqual([expect.objectContaining({ shipmentId: failedId, status: 'failed' })]);
  });
});
