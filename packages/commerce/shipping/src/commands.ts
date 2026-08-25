import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import {
  advanceShipmentStageInput, beginPickupSelectionInput, beginPickupSelectionOutput, completePickupSelectionInput, completePickupSelectionOutput, createShipmentInput, createShippingMethodInput, recordProviderCallbackInput, recordProviderShipmentInput, recordProviderStatusInput,
  shipmentDto, shippingMethodDto, updateShippingMethodInput, type ShipmentDto, type ShippingMethodDto,
} from './dto';
import { ShippingRepository, toShippingMethodDto } from './repository';
import { shippingService, type ShipmentOrderLookup, type ShipmentRefundGuard } from './service';

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

export const beginPickupSelectionCommand = defineCommand({
  name: 'commerce.shipping.beginPickupSelection', summary: '建立超商選店回填權杖', input: beginPickupSelectionInput,
  output: beginPickupSelectionOutput, permission: 'shipping:read', idempotency: 'optional',
  audit: { action: 'shipping.pickup_selection.started', resourceType: 'cart', resourceId: (input) => input.cartId, redact: () => ({}) },
});
export const beginPickupSelectionHandler = (providers: ProviderRegistry) =>
  (input: z.infer<typeof beginPickupSelectionInput>, ctx: CommandContext) => shippingService.beginPickupSelection(ctx, input, providers);

export const completePickupSelectionCommand = defineCommand({
  name: 'commerce.shipping.completePickupSelection', summary: '回填超商門市', input: completePickupSelectionInput,
  output: completePickupSelectionOutput, permission: 'shipping:read', idempotency: 'optional',
  audit: { action: 'shipping.pickup_selection.completed', resourceType: 'pickup_selection', resourceId: () => 'opaque', redact: () => ({}) },
});
export const completePickupSelectionHandler = (providers: ProviderRegistry) =>
  (input: z.infer<typeof completePickupSelectionInput>, ctx: CommandContext) => shippingService.completePickupSelection(ctx, input, providers);

export const createShipmentCommand = defineCommand({
  name: 'commerce.shipping.createShipment', summary: '建立物流單', input: createShipmentInput,
  output: shipmentDto, permission: 'shipping:write', idempotency: 'required',
  audit: { action: 'shipping.shipment.created', resourceType: 'shipment', resourceId: (_i, o: ShipmentDto) => o.id },
});

export const createShipmentHandler = (orders: ShipmentOrderLookup, providers: ProviderRegistry, refunds?: ShipmentRefundGuard) =>
  (input: z.infer<typeof createShipmentInput>, ctx: CommandContext): Promise<ShipmentDto> =>
    shippingService.createShipment(ctx, input, orders, providers, refunds);

/** Carrier extensions persist a completed remote create without exposing their HTTP protocol to Shipping. */
export const recordProviderShipmentCommand = defineCommand({
  name: 'commerce.shipping.recordProviderShipment', summary: '記錄 carrier 建單結果', input: recordProviderShipmentInput,
  output: shipmentDto, permission: 'shipping:provider-write', idempotency: 'required',
  audit: {
    action: 'shipping.shipment.provider_recorded', resourceType: 'shipment', resourceId: (i) => i.shipmentId,
    // Keep a normalized, reviewable outcome without persisting the opaque
    // label handle or any carrier request payload (which may contain PII).
    redact: (i) => ({
      provider: i.provider,
      reference: i.reference,
      providerRef: i.providerRef,
      trackingNumber: i.trackingNumber ?? null,
      labelAvailable: Boolean(i.labelReference),
    }),
  },
});

export const recordProviderShipmentHandler = (input: z.infer<typeof recordProviderShipmentInput>, ctx: CommandContext): Promise<ShipmentDto> =>
  shippingService.recordProviderShipment(ctx, input);

/** A carrier adapter records private evidence; it cannot mutate another provider's shipment. */
export const recordProviderStatusCommand = defineCommand({
  name: 'commerce.shipping.recordProviderStatus', summary: '記錄 carrier 主動查詢狀態', input: recordProviderStatusInput,
  output: shipmentDto, permission: 'shipping:provider-write', idempotency: 'required',
  audit: {
    action: 'shipping.shipment.provider_status_recorded', resourceType: 'shipment', resourceId: (input) => input.shipmentId,
    // Raw provider material is private operational evidence and may contain
    // fields not suitable for the longer-lived audit retention policy.
    redact: (input) => ({ provider: input.provider, stage: input.stage ?? null }),
  },
});
export const recordProviderStatusHandler = (input: z.infer<typeof recordProviderStatusInput>, ctx: CommandContext): Promise<ShipmentDto> =>
  shippingService.recordProviderStatus(ctx, input);

export const recordProviderCallbackCommand = defineCommand({
  name: 'commerce.shipping.recordProviderCallback', summary: '記錄已驗簽 carrier callback', input: recordProviderCallbackInput,
  output: shipmentDto, permission: 'shipping:provider-write', idempotency: 'required',
  audit: {
    action: 'shipping.shipment.provider_callback_recorded', resourceType: 'shipment', resourceId: (_input, output: ShipmentDto) => output.id,
    redact: (input) => ({ provider: input.provider, stage: input.stage ?? null }),
  },
});
export const recordProviderCallbackHandler = (input: z.infer<typeof recordProviderCallbackInput>, ctx: CommandContext): Promise<ShipmentDto> =>
  shippingService.recordProviderCallback(ctx, input);

export const advanceShipmentStageCommand = defineCommand({
  name: 'commerce.shipping.advanceShipmentStage', summary: '推進出貨領域階段', input: advanceShipmentStageInput,
  output: shipmentDto, permission: 'shipping:write', idempotency: 'required',
  audit: { action: 'shipping.shipment.stage_advanced', resourceType: 'shipment', resourceId: (i) => i.shipmentId },
});

export const advanceShipmentStageHandler = (input: z.infer<typeof advanceShipmentStageInput>, ctx: CommandContext): Promise<ShipmentDto> =>
  shippingService.advanceStage(ctx, input);
