import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import {
  checkoutShippingQuoteInput, checkoutShippingQuoteOutput,
  getShipmentInput, getShippingMethodInput, listShippingMethodsInput, listShippingMethodsOutput,
  shipmentDto, shippingMethodDto,
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

export const getShipmentQuery = defineQuery({
  name: 'commerce.shipping.getShipment', summary: '取得物流單', input: getShipmentInput,
  output: shipmentDto, permission: 'shipping:shipment-read',
});
export const getShipmentHandler = async (input: z.infer<typeof getShipmentInput>, ctx: QueryContext) => {
  const row = await repository.findShipmentById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('Shipment', input.id);
  return toShipmentDto(row);
};
