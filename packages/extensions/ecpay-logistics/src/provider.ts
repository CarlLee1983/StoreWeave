import { createHash } from 'node:crypto';
import { constantTimeEquals } from '@storeweave/extension-sdk';
import type {
  ExtensionContext, ShippingCallbackEvent, ShippingCallbackRequest, ShippingProvider, ShippingShipmentInput, ShippingShipmentResult, ShippingShipmentStatusInput, ShippingShipmentStatusResult,
} from '@storeweave/extension-sdk';
import {
  ECPAY_LOGISTICS_HASH_IV_SECRET, ECPAY_LOGISTICS_HASH_KEY_SECRET,
  ECPAY_LOGISTICS_MERCHANT_ID_SECRET, ECPAY_LOGISTICS_PROVIDER_ID,
  type EcpayLogisticsConfig,
} from './config';

interface FakeRemoteShipment {
  readonly result: ShippingShipmentResult;
  readonly createdAt: string;
}

/** Live operations stay explicitly blocked until an enabled ECPay product contract has UAT evidence. */
export class EcpayLogisticsExternalGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcpayLogisticsExternalGateError';
  }
}

/**
 * First carrier adapter boundary. It owns ECPay-specific configuration and
 * secret lookup, while its public surface remains the SDK's ShippingProvider.
 *
 * Fake mode models an ambiguous timeout *after* remote creation, so tests can
 * prove replay uses the same platform reference rather than a second shipment.
 * Live ECPay HTTP is intentionally absent until the merchant picks one of the
 * officially documented logistics contracts and validates it in UAT.
 */
export function createEcpayLogisticsProvider(ctx: ExtensionContext<EcpayLogisticsConfig>): ShippingProvider {
  requireCredentials(ctx);

  return {
    id: ECPAY_LOGISTICS_PROVIDER_ID,
    kind: 'shipping',

    async createShipment(input: ShippingShipmentInput): Promise<ShippingShipmentResult> {
      assertSupportedHomeDelivery(ctx.config, input);
      if (ctx.config.mode !== 'fake') {
        throw new EcpayLogisticsExternalGateError(
          'ECPay logistics live create is blocked pending merchant product selection, account enablement, and UAT contract verification',
        );
      }
      return createFakeShipment(ctx, input);
    },

    async queryShipmentStatus(input: ShippingShipmentStatusInput): Promise<ShippingShipmentStatusResult> {
      if (ctx.config.mode !== 'fake') {
        throw new EcpayLogisticsExternalGateError(
          'ECPay logistics live status query is blocked pending merchant product selection and UAT contract verification',
        );
      }
      return queryFakeShipmentStatus(ctx, input);
    },

    async parseCallback(request: ShippingCallbackRequest) {
      if (ctx.config.mode !== 'fake') {
        throw new EcpayLogisticsExternalGateError('ECPay logistics live callback is blocked pending merchant product selection and UAT contract verification');
      }
      return parseFakeCallback(ctx, request);
    },

    acknowledgeCallback({ accepted }) {
      return { statusCode: accepted ? 200 : 400, body: accepted ? 'OK' : 'REJECTED' };
    },

    async pickupStores(input) {
      if (ctx.config.mode !== 'fake' || !ctx.config.pickupServiceTypes.includes(input.serviceType)) {
        throw new EcpayLogisticsExternalGateError('ECPay logistics live pickup selection is blocked pending merchant product selection and UAT contract verification');
      }
      return ctx.config.pickupStores;
    },

    async healthCheck() {
      if (ctx.config.mode === 'fake') {
        return { ok: true, message: `ECPay logistics fake carrier enabled (${ctx.config.environment})` };
      }
      return {
        ok: false,
        message: `ECPay logistics ${ctx.config.environment} configuration is present, but live calls remain gated until the merchant's service subtype and UAT contract are confirmed`,
      };
    },
  };
}

/**
 * Fake-only callback envelope. This intentionally does not mimic a live ECPay
 * protocol: UAT must define that protocol before production parsing is added.
 */
function parseFakeCallback(ctx: ExtensionContext<EcpayLogisticsConfig>, request: ShippingCallbackRequest): ShippingCallbackEvent {
  const fields = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body)));
  const signature = fields.signature;
  delete fields.signature;
  const hashKey = ctx.secret(ECPAY_LOGISTICS_HASH_KEY_SECRET)!;
  const canonical = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))).toString();
  const expected = createHash('sha256').update(`fake-ecpay-logistics:${hashKey}:${canonical}`).digest('hex');
  if (!signature || !constantTimeEquals(signature, expected)) throw new Error('invalid fake ECPay logistics callback signature');
  const stage = fields.stage as ShippingCallbackEvent['stage'];
  if (stage !== undefined && stage !== 'shipped' && stage !== 'arrived' && stage !== 'completed') {
    throw new Error('invalid fake ECPay logistics callback stage');
  }
  if (!fields.providerRef || !fields.rawStatus || !fields.callbackId) throw new Error('incomplete fake ECPay logistics callback');
  if (fields.trackingUrl) {
    const url = new URL(fields.trackingUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe fake ECPay logistics tracking URL');
  }
  return {
    providerRef: fields.providerRef, rawStatus: fields.rawStatus, callbackId: fields.callbackId,
    ...(stage ? { stage } : {}), ...(fields.trackingUrl ? { trackingUrl: fields.trackingUrl } : {}),
  };
}

function requireCredentials(ctx: ExtensionContext<EcpayLogisticsConfig>): void {
  const merchantId = ctx.secret(ECPAY_LOGISTICS_MERCHANT_ID_SECRET);
  const hashKey = ctx.secret(ECPAY_LOGISTICS_HASH_KEY_SECRET);
  const hashIv = ctx.secret(ECPAY_LOGISTICS_HASH_IV_SECRET);
  if (!merchantId || !hashKey || !hashIv) {
    throw new Error('ECPay logistics credentials are not available from required secrets');
  }
}

function assertSupportedHomeDelivery(config: EcpayLogisticsConfig, input: ShippingShipmentInput): void {
  if (input.destination.kind !== 'taiwan_home') {
    throw new Error('ECPay logistics adapter currently supports taiwan_home shipments only');
  }
  if (!config.homeDeliveryServiceTypes.includes(input.serviceType)) {
    throw new Error(`ECPay logistics service type is not enabled: ${input.serviceType}`);
  }
}

async function createFakeShipment(ctx: ExtensionContext<EcpayLogisticsConfig>, input: ShippingShipmentInput): Promise<ShippingShipmentResult> {
  const key = `fake-remote:${input.reference}`;
  const remote = await ctx.store.mutate<FakeRemoteShipment>(key, (existing) => {
    if (existing) return existing;
    const suffix = createHash('sha256').update(input.reference).digest('hex').slice(0, 16).toUpperCase();
    return {
      result: {
        providerRef: `ECPAY-${suffix}`,
        trackingNumber: `TW-${suffix}`,
        // Locally generated opaque handle. It is not an upstream URL or print payload.
        label: { reference: `LABEL-${suffix}` },
      },
      createdAt: ctx.now().toISOString(),
    };
  });

  const timeoutAttempt = await ctx.store.mutate<number>(`fake-timeout:${input.reference}`, (current) => (current ?? 0) + 1);
  if (timeoutAttempt <= ctx.config.fakeTimeoutsAfterCreate) {
    throw new Error(`simulated ECPay logistics timeout after remote create (${timeoutAttempt}/${ctx.config.fakeTimeoutsAfterCreate})`);
  }
  return remote.result;
}

async function queryFakeShipmentStatus(
  ctx: ExtensionContext<EcpayLogisticsConfig>, input: ShippingShipmentStatusInput,
): Promise<ShippingShipmentStatusResult> {
  const remote = await ctx.store.get<FakeRemoteShipment>(`fake-remote:${input.reference}`);
  if (!remote || remote.result.providerRef !== input.providerRef) {
    throw new Error(`fake ECPay logistics shipment was not found for ${input.shipmentId}`);
  }
  const stage = ctx.config.fakeQueryStage;
  return {
    rawStatus: `fake_${stage}`,
    ...(stage === 'created' ? {} : { stage }),
  };
}
