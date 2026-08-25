import { z } from 'zod';

const money = z.number().int().nonnegative();
const methodCode = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const providerOrType = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
/** A carrier label handle must be opaque metadata, never a URL or signed credential. */
const labelReference = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const trackingUrl = z.string().max(2_000).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Tracking URL must be an HTTPS URL without credentials');

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

const pickupToken = z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const beginPickupSelectionInput = z.object({ cartId: z.string().uuid(), shippingMethodId: z.string().uuid() }).strict();
export const beginPickupSelectionOutput = z.object({ token: pickupToken, expiresAt: z.coerce.date() }).strict();
export const completePickupSelectionOutput = z.object({ expiresAt: z.coerce.date() }).strict();
export const completePickupSelectionInput = z.object({ token: pickupToken, providerStoreId: z.string().min(1).max(120) }).strict();
export const pickupSelectionViewInput = z.object({ token: pickupToken, cartId: z.string().uuid(), customerId: z.string().uuid(), shippingMethodId: z.string().uuid().optional() }).strict();
export const pickupSelectionViewDto = z.object({
  token: pickupToken, shippingMethodId: z.string().uuid(), provider: providerOrType, type: providerOrType,
  expiresAt: z.coerce.date(), store: z.object({ providerStoreId: z.string(), storeName: z.string(), storeAddress: z.string() }).nullable(),
}).strict();
export type PickupSelectionViewDto = z.infer<typeof pickupSelectionViewDto>;

/** Public shipment view. Raw provider status is deliberately excluded (ADR 0031). */
export const shipmentDto = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  shippingMethodId: z.string().uuid(),
  provider: providerOrType,
  type: providerOrType,
  providerRef: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  trackingUrl: trackingUrl.nullable(),
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

/**
 * Private projection for a carrier adapter. The customer-facing Shipment DTO
 * deliberately cannot carry recipient data, idempotency references, or labels.
 */
export const providerShipmentRequestDto = z.object({
  shipmentId: z.string().uuid(),
  orderId: z.string().uuid(),
  provider: providerOrType,
  serviceCode: methodCode,
  serviceType: providerOrType,
  reference: z.string().min(1).max(200),
  destination: shippingDestinationInput,
  /** Existing locally-recorded evidence means an import/manual path already created the consignment. */
  existingProviderRef: z.string().min(1).max(200).nullable(),
  existingTrackingNumber: z.string().min(1).max(200).nullable(),
}).strict();
export type ProviderShipmentRequestDto = z.infer<typeof providerShipmentRequestDto>;

/** Carrier-only reconciliation projection: intentionally excludes delivery PII and label material. */
export const providerShipmentStatusRequestDto = z.object({
  shipmentId: z.string().uuid(),
  provider: providerOrType,
  reference: z.string().min(1).max(200),
  providerRef: z.string().min(1).max(200),
  trackingNumber: z.string().min(1).max(200).nullable(),
}).strict();
export type ProviderShipmentStatusRequestDto = z.infer<typeof providerShipmentStatusRequestDto>;

/** Only a matching carrier adapter can write its provider-neutral result. */
export const recordProviderShipmentInput = z.object({
  shipmentId: z.string().uuid(),
  provider: providerOrType,
  /** Must match the platform reference frozen with this shipment before any carrier I/O. */
  reference: z.string().min(1).max(200),
  providerRef: z.string().min(1).max(200),
  trackingNumber: z.string().min(1).max(200).optional(),
  labelReference: labelReference.optional(),
}).strict();

/** Only the owning carrier adapter may persist raw provider evidence and advance a mapped domain stage. */
export const recordProviderStatusInput = z.object({
  shipmentId: z.string().uuid(),
  provider: providerOrType,
  rawStatus: z.string().min(1).max(200),
  stage: z.enum(['shipped', 'arrived', 'completed']).optional(),
}).strict();

/** Only the generic verified-callback controller may use this provider-ref lookup path. */
export const recordProviderCallbackInput = z.object({
  provider: providerOrType,
  providerRef: z.string().min(1).max(200),
  rawStatus: z.string().min(1).max(200),
  /** Private, lossless raw bytes encoded by the callback controller; never returned from Shipping. */
  callbackPayloadBase64: z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  stage: z.enum(['shipped', 'arrived', 'completed']).optional(),
  callbackId: z.string().min(1).max(400),
  trackingUrl: trackingUrl.optional(),
}).strict();

/** Authorised operators receive an opaque label reference, never a vendor URL or file. */
export const shipmentLabelInfoDto = z.object({
  shipmentId: z.string().uuid(),
  provider: providerOrType,
  providerRef: z.string().min(1).max(200),
  labelReference: labelReference,
}).strict();
export type ShipmentLabelInfoDto = z.infer<typeof shipmentLabelInfoDto>;

export const advanceShipmentStageInput = z.object({
  shipmentId: z.string().uuid(),
  status: z.enum(['shipped', 'arrived', 'completed']),
}).strict();

export const getShippingMethodInput = z.object({ id: z.string().uuid().optional(), code: methodCode.optional() })
  .strict().refine((v) => Boolean(v.id || v.code), { message: 'Either id or code is required' });
export const listShippingMethodsInput = z.object({ enabled: z.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).strict();
export const listShippingMethodsOutput = z.object({ items: z.array(shippingMethodDto), total: z.number().int().nonnegative() });
export const getShipmentInput = z.object({ id: z.string().uuid() }).strict();
