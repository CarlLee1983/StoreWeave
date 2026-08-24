import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import {
  advanceShipmentStageInput, createShipmentInput, createShippingMethodInput, shipmentDto,
  shippingMethodDto, updateShippingMethodInput, type ShipmentDto, type ShippingMethodDto,
} from './dto';
import { ShippingRepository, toShippingMethodDto } from './repository';
import { shippingService, type ShipmentOrderLookup } from './service';

const repository = new ShippingRepository();

export const createShippingMethodCommand = defineCommand({
  name: 'commerce.shipping.createShippingMethod', summary: '建立運送方式', input: createShippingMethodInput,
  output: shippingMethodDto, permission: 'shipping:write', idempotency: 'optional',
  audit: { action: 'shipping.method.created', resourceType: 'shipping_method', resourceId: (_i, o: ShippingMethodDto) => o.id },
});

export const createShippingMethodHandler = async (input: z.infer<typeof createShippingMethodInput>, ctx: CommandContext): Promise<ShippingMethodDto> => {
  if (await repository.findMethodByCode(ctx.tx, input.code)) throw PlatformError.conflict(`Shipping method code "${input.code}" already exists`);
  const row = await repository.insertMethod(ctx.tx, {
    id: randomUUID(), ...input, freeShippingThresholdCents: input.freeShippingThresholdCents ?? null,
    createdAt: ctx.now, updatedAt: ctx.now,
  });
  return toShippingMethodDto(row);
};

export const updateShippingMethodCommand = defineCommand({
  name: 'commerce.shipping.updateShippingMethod', summary: '更新運送方式', input: updateShippingMethodInput,
  output: shippingMethodDto, permission: 'shipping:write', idempotency: 'optional',
  audit: { action: 'shipping.method.updated', resourceType: 'shipping_method', resourceId: (i) => i.id },
});

export const updateShippingMethodHandler = async (input: z.infer<typeof updateShippingMethodInput>, ctx: CommandContext): Promise<ShippingMethodDto> => {
  const { id, ...patch } = input;
  if (!Object.values(patch).some((value) => value !== undefined)) throw PlatformError.validation('No fields to update');
  const row = await repository.updateMethod(ctx.tx, id, patch, ctx.now);
  if (!row) throw PlatformError.notFound('ShippingMethod', id);
  return toShippingMethodDto(row);
};

export const createShipmentCommand = defineCommand({
  name: 'commerce.shipping.createShipment', summary: '建立物流單', input: createShipmentInput,
  output: shipmentDto, permission: 'shipping:write', idempotency: 'required',
  audit: { action: 'shipping.shipment.created', resourceType: 'shipment', resourceId: (_i, o: ShipmentDto) => o.id },
});

export const createShipmentHandler = (orders: ShipmentOrderLookup) =>
  (input: z.infer<typeof createShipmentInput>, ctx: CommandContext): Promise<ShipmentDto> =>
    shippingService.createShipment(ctx, input, orders);

export const advanceShipmentStageCommand = defineCommand({
  name: 'commerce.shipping.advanceShipmentStage', summary: '推進出貨領域階段', input: advanceShipmentStageInput,
  output: shipmentDto, permission: 'shipping:write', idempotency: 'required',
  audit: { action: 'shipping.shipment.stage_advanced', resourceType: 'shipment', resourceId: (i) => i.shipmentId },
});

export const advanceShipmentStageHandler = (input: z.infer<typeof advanceShipmentStageInput>, ctx: CommandContext): Promise<ShipmentDto> =>
  shippingService.advanceStage(ctx, input);
