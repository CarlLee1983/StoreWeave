import { z } from 'zod';

const money = z.number().int().nonnegative();
const methodCode = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const providerOrType = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

export const shippingDestinationKind = z.enum(['taiwan_home', 'pickup_store']);
export type ShippingDestinationKind = z.infer<typeof shippingDestinationKind>;

/** Checkout destination data is provider-neutral; an adapter resolves its own store identifiers later. */
export const shippingDestinationInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('taiwan_home'),
    countryCode: z.literal('TW'),
    recipient: z.string().min(1).max(120),
    phone: z.string().min(1).max(40),
    postcode: z.string().min(1).max(20),
    city: z.string().min(1).max(80),
    district: z.string().min(1).max(80),
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('pickup_store'),
    providerStoreId: z.string().min(1).max(120),
    storeName: z.string().min(1).max(200),
    storeAddress: z.string().min(1).max(400),
    recipient: z.string().min(1).max(120),
    phone: z.string().min(1).max(40),
  }).strict(),
]);
export type ShippingDestinationInput = z.infer<typeof shippingDestinationInput>;

export const shipmentStatus = z.enum(['created', 'shipped', 'arrived', 'completed']);
export type ShipmentStatus = z.infer<typeof shipmentStatus>;

export const shippingMethodDto = z.object({
  id: z.string().uuid(),
  code: methodCode,
  name: z.string(),
  provider: providerOrType,
  type: providerOrType,
  destinationKind: shippingDestinationKind,
  feeCents: money,
  freeShippingThresholdCents: money.nullable(),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ShippingMethodDto = z.infer<typeof shippingMethodDto>;

/** Immutable checkout-time projection; order persists this rather than reinterpreting merchant policy. */
export const checkoutShippingMethodSnapshot = z.object({
  id: z.string().uuid(),
  code: methodCode,
  name: z.string(),
  provider: providerOrType,
  type: providerOrType,
  destinationKind: shippingDestinationKind,
  shippingCents: money,
});
export type CheckoutShippingMethodSnapshot = z.infer<typeof checkoutShippingMethodSnapshot>;

/**
 * Read-only checkout preview. The client supplies only the selected merchant
 * method and the server-derived cart subtotal; Order independently resolves the
 * same method again when it freezes an order.
 */
export const checkoutShippingQuoteInput = z.object({
  shippingMethodId: z.string().uuid(),
  subtotalCents: money,
  destinationKind: shippingDestinationKind,
}).strict();
export const checkoutShippingQuoteOutput = z.object({ shippingCents: money });

/** Public shipment view. Raw provider status is deliberately excluded (ADR 0031). */
export const shipmentDto = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  shippingMethodId: z.string().uuid(),
  provider: providerOrType,
  type: providerOrType,
  providerRef: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  status: shipmentStatus,
  createdAt: z.coerce.date(),
  shippedAt: z.coerce.date().nullable(),
  arrivedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date(),
});
export type ShipmentDto = z.infer<typeof shipmentDto>;

export const createShippingMethodInput = z.object({
  code: methodCode,
  name: z.string().min(1).max(200),
  provider: providerOrType,
  type: providerOrType,
  destinationKind: shippingDestinationKind,
  feeCents: money,
  freeShippingThresholdCents: money.optional(),
  enabled: z.boolean().default(true),
}).strict();

export const updateShippingMethodInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  provider: providerOrType.optional(),
  type: providerOrType.optional(),
  destinationKind: shippingDestinationKind.optional(),
  feeCents: money.optional(),
  freeShippingThresholdCents: money.nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const createShipmentInput = z.object({
  orderId: z.string().uuid(),
  providerRef: z.string().min(1).max(200).optional(),
  trackingNumber: z.string().min(1).max(200).optional(),
}).strict();

export const advanceShipmentStageInput = z.object({
  shipmentId: z.string().uuid(),
  status: z.enum(['shipped', 'arrived', 'completed']),
}).strict();

export const getShippingMethodInput = z.object({ id: z.string().uuid().optional(), code: methodCode.optional() })
  .strict().refine((v) => Boolean(v.id || v.code), { message: 'Either id or code is required' });
export const listShippingMethodsInput = z.object({ enabled: z.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).strict();
export const listShippingMethodsOutput = z.object({ items: z.array(shippingMethodDto), total: z.number().int().nonnegative() });
export const getShipmentInput = z.object({ id: z.string().uuid() }).strict();
