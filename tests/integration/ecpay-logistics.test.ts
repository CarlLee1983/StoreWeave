import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineExtension } from '@storeweave/extension-sdk';
import { RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB } from '@storeweave/ext-ecpay-logistics';
import {
  ADMIN_ACTOR, actorWith, checkoutInput, createCustomer, createHarness, createProduct,
  payOrder, runJobsUntilProcessed, settleWorker, stockUp, type TestHarness,
} from './helpers';

const logisticsSecrets = {
  ECPAY_LOGISTICS_MERCHANT_ID: 'test-logistics-merchant-id',
  ECPAY_LOGISTICS_HASH_KEY: 'test-logistics-hash-key',
  ECPAY_LOGISTICS_HASH_IV: 'test-logistics-hash-iv',
};

function logisticsExtensions(config: Record<string, unknown> = {}) {
  return {
    'mock-payment': { autoApprove: true },
    'ecpay-logistics': { mode: 'fake', maxAttempts: 5, ...config },
  };
}

async function paidCarrierOrder(harness: TestHarness) {
  const customer = await createCustomer(harness.runtime);
  const product = await createProduct(harness.runtime, { priceCents: 1_000 });
  await stockUp(harness.runtime, product.id, 10);
  await harness.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, {
    actor: customer, idempotencyKey: randomUUID(),
  });
  const cart = await harness.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const method = await harness.runtime.commands.execute<{ id: string }>('commerce.shipping.createShippingMethod', {
    code: `ecpay-home-${randomUUID().slice(0, 8)}`,
    name: 'ECPay test home delivery', provider: 'ecpay-logistics', type: 'home_delivery',
    destinationKind: 'taiwan_home', feeCents: 100, enabled: true,
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  const order = await harness.runtime.commands.execute<{ id: string; status: string }>(
    'commerce.order.checkoutCart',
    { ...checkoutInput(harness, cart.id), shippingMethodId: method.id },
    { actor: customer, idempotencyKey: randomUUID() },
  );
  await payOrder(harness.runtime, order.id);
  expect((await runJobsUntilProcessed(harness.worker)).failed).toBe(0);
  const paid = await harness.runtime.queries.execute<{ id: string; status: string }>(
    'commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR },
  );
  expect(paid.status).toBe('paid');
  return { customer, method, order: paid };
}

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness({ extensions: logisticsExtensions(), secrets: logisticsSecrets });
}, 300_000);
afterAll(async () => { await h?.close(); });

describe('ECPay logistics adapter integration', () => {
  it('commits a paid shipment locally before the worker persists fake-carrier evidence', async () => {
    const { order } = await paidCarrierOrder(h);
    const shipment = await h.runtime.commands.execute<any>('commerce.shipping.createShipment', {
      orderId: order.id,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    // The command only commits the provider-neutral shipment and outbox event.
    const before = await h.runtime.queries.execute<any>('commerce.shipping.getShipment', { id: shipment.id }, { actor: ADMIN_ACTOR });
    expect(before).toMatchObject({ id: shipment.id, provider: 'ecpay-logistics', providerRef: null, trackingNumber: null });
    expect(before).not.toHaveProperty('destination');
    expect(before).not.toHaveProperty('labelReference');

    await settleWorker(h.worker);
    const after = await h.runtime.queries.execute<any>('commerce.shipping.getShipment', { id: shipment.id }, { actor: ADMIN_ACTOR });
    expect(after).toMatchObject({
      id: shipment.id, providerRef: expect.stringMatching(/^ECPAY-/), trackingNumber: expect.stringMatching(/^TW-/),
    });
    expect(JSON.stringify(after)).not.toContain('測試收件人');

    const operation = await h.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
      shipmentId: shipment.id,
    }, { actor: ADMIN_ACTOR });
    expect(operation).toMatchObject({ status: 'created', attempts: 1, labelAvailable: true, lastError: null });
    expect(operation).not.toHaveProperty('reference');

    const label = await h.runtime.queries.execute<any>('commerce.shipping.getShipmentLabelInfo', {
      id: shipment.id,
    }, { actor: actorWith(['shipping:label-read']) });
    expect(label).toMatchObject({ shipmentId: shipment.id, provider: 'ecpay-logistics', labelReference: expect.stringMatching(/^LABEL-/) });
    await expect(h.runtime.queries.execute('commerce.shipping.getShipmentLabelInfo', {
      id: shipment.id,
    }, { actor: actorWith(['shipping:shipment-read']) })).rejects.toThrow(/Forbidden/);
    await expect(h.runtime.queries.execute('commerce.shipping.getProviderShipmentRequest', {
      id: shipment.id,
    }, { actor: actorWith(['shipping:shipment-read']) })).rejects.toThrow(/Forbidden/);

    const otherCarrierExtension = {
      id: 'extension:other-carrier', type: 'extension' as const, extensionId: 'other-carrier',
      permissions: ['shipping:provider-read', 'shipping:provider-write'],
      providerBindings: ['shipping:other-carrier'],
    };
    await expect(h.runtime.queries.execute('commerce.shipping.getProviderShipmentRequest', {
      id: shipment.id,
    }, { actor: otherCarrierExtension })).rejects.toThrow(/cannot access shipping provider/);

    // A duplicate carrier claim is rejected before setup receives any context,
    // so it cannot impersonate the registered adapter to read this snapshot.
    let duplicateSetupRan = false;
    let leakedSnapshot: unknown;
    const duplicateCarrier = defineExtension({
      manifest: {
        id: 'carrier-probe', name: 'Carrier probe', version: '1.0.0', platformVersion: '^1.0.0',
        configuration: z.object({}).strict(), permissions: ['shipping:provider-read'],
        subscribedEvents: [], registeredCommands: [], registeredQueries: [],
        registeredProviders: [{ kind: 'shipping', id: 'ecpay-logistics' }],
      },
      async setup(ctx) {
        duplicateSetupRan = true;
        leakedSnapshot = await ctx.queries.execute('commerce.shipping.getProviderShipmentRequest', { id: shipment.id });
        return {};
      },
    });
    await expect(h.runtime.extensions.mount(duplicateCarrier, {})).rejects.toThrow(/Provider "shipping:ecpay-logistics" already registered/);
    expect(duplicateSetupRan).toBe(false);
    expect(leakedSnapshot).toBeUndefined();

    const request = await h.runtime.queries.execute<any>('commerce.shipping.getProviderShipmentRequest', {
      id: shipment.id,
    }, { actor: ADMIN_ACTOR });
    expect(request).toMatchObject({ reference: `shipment:${shipment.id}`, destination: { recipient: '測試收件人' } });
    // A repeated completed result is a safe no-op even with a fresh command idempotency key.
    await expect(h.runtime.commands.execute('commerce.shipping.recordProviderShipment', {
      shipmentId: shipment.id, provider: 'ecpay-logistics', reference: request.reference,
      providerRef: after.providerRef, trackingNumber: after.trackingNumber, labelReference: label.labelReference,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).resolves.toMatchObject({ id: shipment.id });
    await expect(h.runtime.commands.execute('commerce.shipping.recordProviderShipment', {
      shipmentId: shipment.id, provider: 'ecpay-logistics', reference: `wrong:${shipment.id}`,
      providerRef: after.providerRef,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.runtime.commands.execute('commerce.shipping.recordProviderShipment', {
      shipmentId: shipment.id, provider: 'ecpay-logistics', reference: request.reference, providerRef: after.providerRef,
    }, { actor: actorWith(['shipping:write']), idempotencyKey: randomUUID() })).rejects.toThrow(/Forbidden/);
    await expect(h.runtime.commands.execute('commerce.shipping.recordProviderShipment', {
      shipmentId: shipment.id, provider: 'ecpay-logistics', reference: request.reference, providerRef: after.providerRef,
    }, { actor: otherCarrierExtension, idempotencyKey: randomUUID() })).rejects.toThrow(/cannot access shipping provider/);

    const providerAudit = (await h.runtime.audit.list(h.runtime.database.db, {
      resourceType: 'shipment', resourceId: shipment.id,
    })).find((entry) => entry.action === 'shipping.shipment.provider_recorded');
    expect(providerAudit?.payload).toMatchObject({
      provider: 'ecpay-logistics', reference: request.reference, providerRef: after.providerRef,
      trackingNumber: after.trackingNumber, labelAvailable: true,
    });
    expect(JSON.stringify(providerAudit)).not.toContain(label.labelReference);
    expect(JSON.stringify(providerAudit)).not.toContain('測試收件人');
  });

  it('does not let an extension claim the core manual provider to read an existing destination', async () => {
    const customer = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { priceCents: 1_000 });
    await stockUp(h.runtime, product.id, 10);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, {
      actor: customer, idempotencyKey: randomUUID(),
    });
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
    const order = await h.runtime.commands.execute<{ id: string }>('commerce.order.checkoutCart', {
      ...checkoutInput(h, cart.id), shippingMethodId: h.defaultShippingMethodId,
    }, { actor: customer, idempotencyKey: randomUUID() });
    await payOrder(h.runtime, order.id);
    expect((await runJobsUntilProcessed(h.worker)).failed).toBe(0);
    const shipment = await h.runtime.commands.execute<any>('commerce.shipping.createShipment', {
      orderId: order.id,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    // `manual` is core-owned. Registering a later provider with that name must
    // not retroactively authorise it to read the frozen manual destination.
    const manualCarrierProbe = defineExtension({
      manifest: {
        id: 'manual-carrier-probe', name: 'Manual carrier probe', version: '1.0.0', platformVersion: '^1.0.0',
        configuration: z.object({}).strict(), permissions: ['shipping:provider-read'],
        subscribedEvents: [], registeredCommands: [], registeredQueries: [],
        registeredProviders: [{ kind: 'shipping', id: 'manual' }],
      },
      setup() {
        return {
          providers: [{
            id: 'manual', kind: 'shipping' as const,
            async createShipment() { return { providerRef: 'probe' }; },
          }],
        };
      },
    });
    const manualProbe = await h.runtime.extensions.mount(manualCarrierProbe, {});
    await expect(manualProbe.context.queries.execute('commerce.shipping.getProviderShipmentRequest', {
      id: shipment.id,
    })).rejects.toThrow(/cannot access shipping provider/);
  });

  it('reconciles a created shipment by proactive provider query without exposing destination or raw status publicly', async () => {
    const { order } = await paidCarrierOrder(h);
    const shipment = await h.runtime.commands.execute<any>('commerce.shipping.createShipment', {
      orderId: order.id,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await settleWorker(h.worker);

    const bucket = Date.now();
    await h.runtime.database.transaction((tx) => h.runtime.jobs.enqueue(tx, {
      type: RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB,
      payload: { bucket, scheduledFor: new Date().toISOString() },
      dedupeKey: `test:ecpay-status-reconcile:${bucket}`,
      maxAttempts: 5,
    }));
    await settleWorker(h.worker);

    const after = await h.runtime.queries.execute<any>('commerce.shipping.getShipment', { id: shipment.id }, { actor: ADMIN_ACTOR });
    expect(after).toMatchObject({ id: shipment.id, status: 'shipped' });
    expect(after).not.toHaveProperty('providerStatusRaw');
    const operation = await h.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
      shipmentId: shipment.id,
    }, { actor: ADMIN_ACTOR });
    expect(operation).toMatchObject({ status: 'created', lastKnownStage: 'shipped', lastStatusQueryError: null });
    expect(operation).not.toHaveProperty('reference');

    const statusRequest = await h.runtime.queries.execute<any>('commerce.shipping.getProviderShipmentStatusRequest', {
      id: shipment.id,
    }, { actor: ADMIN_ACTOR });
    expect(statusRequest).toMatchObject({ shipmentId: shipment.id, provider: 'ecpay-logistics', providerRef: after.providerRef });
    expect(statusRequest).not.toHaveProperty('destination');
    expect(statusRequest).not.toHaveProperty('labelReference');

    const statusAudit = (await h.runtime.audit.list(h.runtime.database.db, {
      resourceType: 'shipment', resourceId: shipment.id,
    })).find((entry) => entry.action === 'shipping.shipment.provider_status_recorded');
    expect(statusAudit?.payload).toMatchObject({ provider: 'ecpay-logistics', stage: 'shipped' });
    expect(JSON.stringify(statusAudit)).not.toContain('fake_shipped');
    expect(JSON.stringify(statusAudit)).not.toContain('測試收件人');

    // Polling answers can lag behind a newer local stage. The late `shipped`
    // answer remains private evidence but must not dead-letter or regress `arrived`.
    await h.runtime.commands.execute('commerce.shipping.advanceShipmentStage', {
      shipmentId: shipment.id, status: 'arrived',
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.database.transaction((tx) => h.runtime.jobs.enqueue(tx, {
      type: RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB,
      payload: { bucket: bucket + 1, scheduledFor: new Date().toISOString() },
      dedupeKey: `test:ecpay-status-reconcile:${bucket + 1}`,
      maxAttempts: 5,
    }));
    await settleWorker(h.worker);
    expect(await h.runtime.queries.execute<any>('commerce.shipping.getShipment', { id: shipment.id }, { actor: ADMIN_ACTOR }))
      .toMatchObject({ status: 'arrived' });
    expect(await h.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
      shipmentId: shipment.id,
    }, { actor: ADMIN_ACTOR })).toMatchObject({ lastKnownStage: 'arrived', lastStatusQueryError: null });
  });

  it('records a retryable ambiguous failure without moving the paid order, then reconciles on retry', async () => {
    const flaky = await createHarness({
      extensions: logisticsExtensions({ fakeTimeoutsAfterCreate: 1 }), secrets: logisticsSecrets,
    });
    try {
      const { order } = await paidCarrierOrder(flaky);
      const shipment = await flaky.runtime.commands.execute<any>('commerce.shipping.createShipment', {
        orderId: order.id,
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

      await settleWorker(flaky.worker);
      let operation = await flaky.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR });
      expect(operation).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringMatching(/timeout/) });
      expect((await flaky.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR })).status).toBe('paid');

      // The automatic backoff job is still pending, so manual retry must not
      // clear its lock / schedule a second create attempt concurrently.
      await expect(flaky.runtime.commands.execute('ext.ecpay-logistics.retryShipment', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/Dead job/);

      // Make the scheduled retry eligible without sleeping through production backoff.
      await flaky.runtime.database.db.execute(sql`
        UPDATE platform_jobs SET run_at = now()
        WHERE type = 'ext.ecpay-logistics.create-shipment' AND status = 'pending'
      `);
      await settleWorker(flaky.worker);
      operation = await flaky.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR });
      expect(operation).toMatchObject({ status: 'created', attempts: 2, lastError: null });
      expect((await flaky.runtime.queries.execute<any>('commerce.shipping.getShipment', { id: shipment.id }, { actor: ADMIN_ACTOR })))
        .toMatchObject({ providerRef: expect.stringMatching(/^ECPAY-/), trackingNumber: expect.stringMatching(/^TW-/) });
    } finally {
      await flaky.close();
    }
  }, 180_000);

  it('allows a manual retry only after the failed carrier job reaches the dead-letter queue', async () => {
    const deadLetter = await createHarness({
      extensions: logisticsExtensions({ fakeTimeoutsAfterCreate: 1, maxAttempts: 1 }), secrets: logisticsSecrets,
    });
    try {
      const { order } = await paidCarrierOrder(deadLetter);
      const shipment = await deadLetter.runtime.commands.execute<any>('commerce.shipping.createShipment', {
        orderId: order.id,
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
      await settleWorker(deadLetter.worker);

      const failedOperation = await deadLetter.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR });
      expect(failedOperation).toMatchObject({ status: 'failed', attempts: 1, jobId: expect.any(String) });

      // A different extension knows this UUID but must not revive a carrier
      // job it does not own; ExtensionHost scopes retry APIs by job namespace.
      let thiefSetupRan = false;
      const jobThief = defineExtension({
        manifest: {
          id: 'job-thief', name: 'Job thief probe', version: '1.0.0', platformVersion: '^1.0.0',
          configuration: z.object({}).strict(), permissions: [],
          subscribedEvents: [], registeredCommands: [], registeredQueries: [], registeredProviders: [],
        },
        async setup(ctx) {
          thiefSetupRan = true;
          await ctx.jobs.retryDead(failedOperation.jobId);
          return {};
        },
      });
      await expect(deadLetter.runtime.extensions.mount(jobThief, {})).rejects.toThrow(/Dead job/);
      expect(thiefSetupRan).toBe(true);

      await expect(deadLetter.runtime.commands.execute<any>('ext.ecpay-logistics.retryShipment', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).resolves.toMatchObject({
        shipmentId: shipment.id, status: 'pending', manualRetries: 1,
      });
      await settleWorker(deadLetter.worker);
      expect(await deadLetter.runtime.queries.execute<any>('ext.ecpay-logistics.getShipmentOperation', {
        shipmentId: shipment.id,
      }, { actor: ADMIN_ACTOR })).toMatchObject({ status: 'created', attempts: 2, manualRetries: 1 });
    } finally {
      await deadLetter.close();
    }
  }, 180_000);
});
