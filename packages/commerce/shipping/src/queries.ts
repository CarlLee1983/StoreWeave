import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import {
  checkoutShippingQuoteInput, checkoutShippingQuoteOutput,
  pickupSelectionViewDto, pickupSelectionViewInput,
  getShipmentInput, getShippingMethodInput, listShippingMethodsInput, listShippingMethodsOutput,
  providerShipmentRequestDto, providerShipmentStatusRequestDto, shipmentDto, shipmentLabelInfoDto, shippingMethodDto,
} from './dto';
import { ShippingRepository, toShipmentDto, toShippingMethodDto } from './repository';
import { shippingService } from './service';

const repository = new ShippingRepository();

export const getShippingMethodQuery = defineQuery({
  name: 'commerce.shipping.getShippingMethod', summary: '取得運送方式', input: getShippingMethodInput,
  output: shippingMethodDto, permission: 'shipping:read',
});
export const getShippingMethodHandler = async (input: z.infer<typeof getShippingMethodInput>, ctx: QueryContext) => {
  const row = input.id ? await repository.findMethodById(ctx.db, input.id) : await repository.findMethodByCode(ctx.db, input.code!);
  if (!row) throw PlatformError.notFound('ShippingMethod', input.id ?? input.code);
  return toShippingMethodDto(row);
};

export const listShippingMethodsQuery = defineQuery({
  name: 'commerce.shipping.listShippingMethods', summary: '列出運送方式', input: listShippingMethodsInput,
  output: listShippingMethodsOutput, permission: 'shipping:read',
});
export const listShippingMethodsHandler = async (input: z.infer<typeof listShippingMethodsInput>, ctx: QueryContext) => {
  const { items, total } = await repository.listMethods(ctx.db, input);
  return { items: items.map(toShippingMethodDto), total };
};

/** The storefront uses this server-derived value for its pre-submit all-in total. */
export const checkoutShippingQuoteQuery = defineQuery({
  name: 'commerce.shipping.quoteCheckoutShipping', summary: '試算結帳配送費', input: checkoutShippingQuoteInput,
  output: checkoutShippingQuoteOutput, permission: 'shipping:read',
});
export const checkoutShippingQuoteHandler = async (input: z.infer<typeof checkoutShippingQuoteInput>, ctx: QueryContext) => {
  const method = await shippingService.resolveCheckoutMethod(ctx.db, input);
  return { shippingCents: method.shippingCents };
};

export const getPickupSelectionViewQuery = defineQuery({
  name: 'commerce.shipping.getPickupSelectionView', summary: '取得已回填的超商門市', input: pickupSelectionViewInput,
  output: pickupSelectionViewDto, permission: 'shipping:read',
});
export const getPickupSelectionViewHandler = (input: z.infer<typeof pickupSelectionViewInput>, ctx: QueryContext) =>
  shippingService.pickupSelectionView(ctx.db, input);

export const getShipmentQuery = defineQuery({
  name: 'commerce.shipping.getShipment', summary: '取得物流單', input: getShipmentInput,
  output: shipmentDto, permission: 'shipping:shipment-read',
});
export const getShipmentHandler = async (input: z.infer<typeof getShipmentInput>, ctx: QueryContext) => {
  const row = await repository.findShipmentById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('Shipment', input.id);
  return toShipmentDto(row);
};

/** Internal storefront composition calls this only after Order has scoped ownership. */
export const getShipmentForOrderQuery = defineQuery({
  name: 'commerce.shipping.getShipmentForOrder', summary: '依訂單取得物流單', input: z.object({ orderId: z.string().uuid() }).strict(),
  output: shipmentDto, permission: 'shipping:shipment-read',
});
export const getShipmentForOrderHandler = async (input: { orderId: string }, ctx: QueryContext) => {
  const row = await repository.findShipmentByOrderId(ctx.db, input.orderId);
  if (!row) throw PlatformError.notFound('Shipment for order', input.orderId);
  return toShipmentDto(row);
};

/**
 * Carrier-only projection. The provider extension is granted this permission;
 * ordinary shipment reads never receive delivery PII or idempotency material.
 */
export const getProviderShipmentRequestQuery = defineQuery({
  name: 'commerce.shipping.getProviderShipmentRequest', summary: '取得 carrier 建單快照',
  input: getShipmentInput, output: providerShipmentRequestDto, permission: 'shipping:provider-read',
});
export const getProviderShipmentRequestHandler = (input: z.infer<typeof getShipmentInput>, ctx: QueryContext) =>
  shippingService.providerShipmentRequest(ctx.db, input.id, ctx.actor);

/** Carrier reconciliation gets only immutable references, never the delivery snapshot. */
export const getProviderShipmentStatusRequestQuery = defineQuery({
  name: 'commerce.shipping.getProviderShipmentStatusRequest', summary: '取得 carrier 主動查詢參照',
  input: getShipmentInput, output: providerShipmentStatusRequestDto, permission: 'shipping:provider-read',
});
export const getProviderShipmentStatusRequestHandler = (input: z.infer<typeof getShipmentInput>, ctx: QueryContext) =>
  shippingService.providerShipmentStatusRequest(ctx.db, input.id, ctx.actor);

/** The reference is private operational metadata used by an authorised label-print flow. */
export const getShipmentLabelInfoQuery = defineQuery({
  name: 'commerce.shipping.getShipmentLabelInfo', summary: '取得物流標籤列印參照',
  input: getShipmentInput, output: shipmentLabelInfoDto, permission: 'shipping:label-read',
});
export const getShipmentLabelInfoHandler = (input: z.infer<typeof getShipmentInput>, ctx: QueryContext) =>
  shippingService.shipmentLabelInfo(ctx.db, input.id);
