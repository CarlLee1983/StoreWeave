import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, SYSTEM_ACTOR } from '@storeweave/contracts';
import {
  definePage,
  formValue,
  type PageResolveContext,
  type StorefrontHttpContract,
  type StorefrontResponse,
} from '@storeweave/kernel';
import type { PaymentProvider } from '@storeweave/extension-sdk';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 訂單明細在前台看得到的樣子。 */
export interface ThemeOrderView {
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  customerEmail: string;
  /** IDs are rendered only as form values for a customer-owned RMA submission. */
  lines: { id: string; sku: string; name: string; quantity: number; lineTotalCents: number }[];
  /** Latest attempt is presented without exposing provider-specific raw callback fields. */
  payment: {
    status: 'created' | 'submitted' | 'awaiting_payment' | 'succeeded' | 'failed' | 'expired';
    method: string;
    action: { type: 'redirect'; url: string } | { type: 'form_post'; url: string; fields: Record<string, string> } | null;
    instructions: { label: string; value: string }[] | null;
    expiresAt: Date | null;
  } | null;
  /** Only pending orders get a new attempt; active deferred attempts are resumed in place. */
  paymentRetry: {
    provider: string;
    methods: { code: string; label: string; timing: 'immediate' | 'deferred' }[];
  } | null;
  /** Customer-safe invoice progress. Carrier values and provider diagnostics stay private. */
  invoice?: { status: 'pending' | 'issued' | 'issue_failed' | 'void_pending' | 'voided' | 'void_failed'; invoiceNumber: string | null } | null;
  /** The command still rechecks ownership, payment state, and the shipment gate. */
  canCancel: boolean;
  /** Immutable delivery snapshot, so an order remains intelligible after merchant policy changes. */
  delivery: {
    shippingMethodName: string;
    destination: {
      kind: 'taiwan_home'; recipient: string; phone: string; postcode: string; city: string; district: string; line1: string; line2: string | null;
    } | {
      kind: 'pickup_store'; recipient: string; phone: string; storeName: string; storeAddress: string;
    };
  } | null;
  /** Safe, normalized shipment projection; raw carrier status and references stay private. */
  shipment: {
    status: 'created' | 'shipped' | 'arrived' | 'completed';
    trackingNumber: string | null;
    trackingUrl: string | null;
  } | null;
  /** Customer-safe refund progress; provider evidence and staff reason stay private. */
  refunds: { amountCents: number; status: 'requested' | 'succeeded' | 'failed'; requestedAt: Date; completedAt: Date | null }[];
  /** The domain command remains the authority for eligibility and remaining quantities. */
  canRequestRma: boolean;
  /** Customer-scoped RMA progress; identities, provider evidence, and inventory disposition stay private. */
  rmas: {
    status: 'requested' | 'needs_information' | 'approved' | 'rejected' | 'received' | 'refund_pending' | 'refund_failed' | 'completed';
    reason: string;
    staffNote: string | null;
    createdAt: Date;
    lines: { name: string; quantity: number }[];
  }[];
}

export interface ThemeAccountOrdersView {
  orders: ThemeOrderSummaryView[];
  /** 分頁：目前這一頁的起點與每頁筆數，以及總筆數。 */
  limit: number;
  offset: number;
  total: number;
}

export interface ThemeOrderSummaryView {
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  placedAt: Date;
  lineCount: number;
}

interface OrderDtoShape {
  id: string; number: string;
}

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

const html = (status: number | 'platform-error' = 200): StorefrontResponse =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
const redirect = (): StorefrontResponse =>
  ({ kind: 'redirect', status: 303, location: { kind: 'server-constructed' } });
const cartNotice = ['cart-notice-consume'] as const;
const pageOrRedirect: StorefrontHttpContract['responses'] = [html(), html('platform-error'), redirect()];
const redirectOrError: StorefrontHttpContract['responses'] = [html('platform-error'), redirect()];

/** Only converts form shape; the RMA command rechecks order ownership and every quantity under lock. */
function formValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
}

function rmaLinesFromForm(body: Record<string, unknown>) {
  return formValues(body.orderLineId).map((orderLineId) => ({
    orderLineId,
    quantity: typeof body[`quantity_${orderLineId}`] === 'string' ? Number(body[`quantity_${orderLineId}`]) : Number.NaN,
  }));
}

const rmaFormWithNumber: JsonSchema7Type = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    orderLineId: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    number: { type: 'string' },
  },
  patternProperties: { '^quantity_.+$': { type: 'string' } },
  additionalProperties: true,
} as unknown as JsonSchema7Type;

/** Resolve through the customer-scoped query before command dispatch so a guessed order number is indistinguishable from a missing one. */
async function scopedOrder(ctx: PageResolveContext, number: string): Promise<OrderDtoShape> {
  return ctx.queries.execute<OrderDtoShape>('commerce.order.getOrder', { number }, { actor: ctx.actor });
}

export const orderPages = {
  order: definePage({
    id: 'commerce.order.view',
    loginNext: params => `/orders/${params.number}`,
    path: '/orders/:number',
    method: 'get',
    audience: 'customer',
    input: z.object({ number: z.string() }),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema(['number']), params: { number: 'number' },
      audience: 'customer', responses: pageOrRedirect, cookieEffects: cartNotice,
    },
    resolve: async (ctx, { number }) => {
      const order = await ctx.queries.execute<any>('commerce.order.getOrder', { number }, { actor: ctx.actor });
      const [refunds, rmas, latestAttempt, shipment, invoice] = await Promise.all([
        ctx.queries.execute<{ items: any[] }>('commerce.refund.listRefunds', { orderId: order.id, limit: 20, offset: 0 }, { actor: ctx.actor }),
        ctx.queries.execute<{ items: any[] }>('commerce.rma.listRmas', { orderId: order.id, limit: 100, offset: 0 }, { actor: ctx.actor }),
        Promise.resolve(order.paymentAttempts.at(-1) ?? null),
        // `getOrder` above has already returned only this customer's order. The
        // shipment query runs as system because customer RBAC deliberately does
        // not grant an unscoped shipment-read capability.
        ctx.queries.execute<any>('commerce.shipping.getShipmentForOrder', { orderId: order.id }, { actor: SYSTEM_ACTOR })
          .catch((error: unknown) => error instanceof PlatformError && error.code === 'NOT_FOUND' ? null : Promise.reject(error)),
        // getOrder above has already enforced ownership. Expose only the
        // customer-safe status and number from the protected invoice record.
        ctx.queries.execute<{ items: any[] }>('commerce.invoice.list', { orderId: order.id, limit: 1, offset: 0 }, { actor: SYSTEM_ACTOR })
          .then((result) => result.items[0] ?? null),
      ]);
      const canContinuePayment = (order.status === 'payment_processing' && latestAttempt?.status === 'submitted')
        || (order.status === 'awaiting_payment' && latestAttempt?.status === 'awaiting_payment');
      const canShowInstructions = order.status === 'awaiting_payment' && latestAttempt?.status === 'awaiting_payment';
      const retryProvider = order.status === 'pending'
        ? ctx.providers.get<PaymentProvider>('payment')
        : null;
      return {
        kind: 'view',
        view: { order: {
          number: order.number,
          status: order.status,
          currency: order.currency,
          totalCents: order.totalCents,
          customerEmail: order.customerEmail,
          lines: order.lines.map((line: any) => ({
            id: line.id, sku: line.sku, name: line.name, quantity: line.quantity, lineTotalCents: line.lineTotalCents,
          })),
          payment: latestAttempt ? {
            status: latestAttempt.status,
            method: latestAttempt.method,
            // Do not carry an action or instructions from a failed/stale
            // attempt into customer HTML. The active order state is the gate.
            action: canContinuePayment ? latestAttempt.action : null,
            instructions: canShowInstructions ? latestAttempt.instructions : null,
            expiresAt: canShowInstructions ? latestAttempt.expiresAt : null,
          } : null,
          paymentRetry: retryProvider && retryProvider.paymentMethods().length > 0 ? {
            provider: retryProvider.id,
            methods: retryProvider.paymentMethods().map((method) => ({
              code: method.code,
              label: method.label,
              timing: method.timing,
            })),
          } : null,
          invoice: invoice ? { status: invoice.status, invoiceNumber: invoice.invoiceNumber } : null,
          // The command also checks for a shipment under the Order lock. The
          // page can only use the status projection and never bypasses it.
          canCancel: order.status === 'pending',
          delivery: order.delivery ? {
            shippingMethodName: order.delivery.shippingMethodName,
            destination: order.delivery.destination,
          } : null,
          shipment: shipment ? {
            status: shipment.status,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
          } : null,
          refunds: refunds.items.map((refund) => ({
            amountCents: refund.amountCents, status: refund.status, requestedAt: refund.requestedAt, completedAt: refund.completedAt,
          })),
          canRequestRma: order.status === 'paid' && Boolean(shipment && shipment.status !== 'created'),
          rmas: rmas.items.map((rma) => ({
            status: rma.status, reason: rma.reason, staffNote: rma.staffNote, createdAt: rma.createdAt,
            lines: rma.lines.map((line: any) => ({ name: line.name, quantity: line.quantity })),
          })),
        } },
      };
    },
  }),

  retryPayment: definePage({
    id: 'commerce.order.retryPayment',
    loginNext: params => `/orders/${params.number}`,
    path: '/orders/:number/pay',
    method: 'post',
    audience: 'customer',
    required: false,
    input: z.object({ number: z.string(), paymentProvider: formValue.optional(), paymentMethod: formValue.optional() }),
    contract: {
      kind: 'storefront', rateLimit: 'cart', request: 'form',
      input: jsonSchema(['number', 'paymentProvider', 'paymentMethod']), params: { number: 'number' },
      audience: 'customer', responses: redirectOrError, cookieEffects: cartNotice,
    },
    resolve: async (ctx, { number, paymentProvider, paymentMethod }) => {
      // Fetch through the scoped query before issuing a write: another
      // customer's number stays indistinguishable from a missing order.
      const order = await scopedOrder(ctx, number);
      const provider = ctx.providers.get<PaymentProvider>('payment', paymentProvider || undefined);
      const method = provider.paymentMethods().find((candidate) => candidate.code === paymentMethod);
      if (!method) throw PlatformError.validation('請先選擇可用的付款方式');
      await ctx.commands.execute('commerce.order.payOrder', {
        orderId: order.id,
        provider: provider.id,
        method: method.code,
      }, {
        actor: ctx.actor,
        // Distinct browser submissions are safe: payOrder serializes on Order
        // and creates at most one active attempt.
        idempotencyKey: `storefront-pay:${order.id}:${randomUUID()}`,
      });
      return { kind: 'redirect', location: `/orders/${order.number}` };
    },
  }),

  accountOrders: definePage({
    id: 'commerce.order.accountList',
    path: '/account/orders',
    method: 'get',
    audience: 'customer',
    input: z.object({ limit: formValue.optional(), offset: formValue.optional() }),
    contract: {
      kind: 'storefront', request: 'query', input: jsonSchema(['limit', 'offset']),
      audience: 'customer', responses: pageOrRedirect, cookieEffects: cartNotice,
    },
    resolve: async (ctx, { limit, offset }) => {
      // 範圍過濾在 query handler：這裡不必、也不該自己加條件（工單 12）。
      const result = await ctx.queries.execute<{ items: any[]; total: number }>(
        'commerce.order.listOrders',
        { limit: limit ?? 20, offset: offset ?? 0 },
        { actor: ctx.actor },
      );
      return {
        kind: 'view',
        view: {
          orders: result.items.map((order) => ({
            number: order.number,
            status: order.status,
            currency: order.currency,
            totalCents: order.totalCents,
            placedAt: order.placedAt,
            lineCount: order.lines.length,
          })),
          limit: Number(limit ?? 20),
          offset: Number(offset ?? 0),
          total: result.total,
        },
      };
    },
  }),

  createRma: definePage({
    id: 'commerce.order.createRma',
    loginNext: params => `/orders/${params.number}`,
    path: '/orders/:number/rmas',
    method: 'post',
    audience: 'customer',
    required: false,
    input: z.object({ number: z.string() }).passthrough(),
    contract: {
      kind: 'storefront', request: 'form', input: rmaFormWithNumber, params: { number: 'number' },
      audience: 'customer', responses: redirectOrError, cookieEffects: cartNotice,
    },
    resolve: async (ctx, body) => {
      const order = await scopedOrder(ctx, body.number as string);
      await ctx.commands.execute('commerce.rma.createRma', {
        orderId: order.id,
        reason: typeof body.reason === 'string' ? body.reason : '',
        lines: rmaLinesFromForm(body as Record<string, unknown>),
      }, { actor: ctx.actor, idempotencyKey: `storefront-rma:${order.id}:${randomUUID()}` });
      return { kind: 'redirect', location: `/orders/${order.number}` };
    },
  }),

  cancelOrder: definePage({
    id: 'commerce.order.cancel',
    loginNext: params => `/orders/${params.number}`,
    path: '/orders/:number/cancel',
    method: 'post',
    audience: 'customer',
    required: false,
    input: z.object({ number: z.string() }),
    contract: {
      kind: 'storefront', rateLimit: 'cart', request: 'none', input: jsonSchema(['number']), params: { number: 'number' },
      audience: 'customer', responses: redirectOrError, cookieEffects: cartNotice,
    },
    resolve: async (ctx, { number }) => {
      const order = await scopedOrder(ctx, number);
      await ctx.commands.execute('commerce.order.cancelOrder', {
        orderId: order.id,
        reason: 'customer request',
      }, { actor: ctx.actor, idempotencyKey: `storefront-cancel:${order.id}:${randomUUID()}` });
      return { kind: 'redirect', location: `/orders/${order.number}` };
    },
  }),
} as const;

export type OrderPages = typeof orderPages;
