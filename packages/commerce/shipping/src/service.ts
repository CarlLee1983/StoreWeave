import { randomUUID } from 'node:crypto';
import { PlatformError, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { shipmentArrivedV1, shipmentCompletedV1, shipmentCreatedV1, shipmentShippedV1 } from './events';
import { ShippingRepository, toShipmentDto } from './repository';
import type { CheckoutShippingMethodSnapshot, ShipmentDto, ShipmentStatus, ShippingDestinationKind } from './dto';

const repository = new ShippingRepository();
const stages: ShipmentStatus[] = ['created', 'shipped', 'arrived', 'completed'];

/** Cross-module port; the bundle wires it to order's narrow fulfillment projection. */
export interface ShipmentOrderLookup {
  deliveryForShipment(tx: Tx, orderId: string): Promise<{
    readonly shippingMethodId: string;
    readonly provider: string;
    readonly type: string;
  } | null>;
}

function stageTimestamp(status: Exclude<ShipmentStatus, 'created'>): 'shippedAt' | 'arrivedAt' | 'completedAt' {
  return status === 'shipped' ? 'shippedAt' : status === 'arrived' ? 'arrivedAt' : 'completedAt';
}

function stageEvent(status: Exclude<ShipmentStatus, 'created'>) {
  return status === 'shipped' ? shipmentShippedV1 : status === 'arrived' ? shipmentArrivedV1 : shipmentCompletedV1;
}

/** The only cross-module interface for merchant policy and shipment lifecycle. */
export const shippingService = {
  /** Calculates customer shipping from a merchant-owned method; no provider is queried. */
  async shippingCentsFor(db: DrizzleDb | Tx, input: { shippingMethodId: string; subtotalCents: number }): Promise<number> {
    const method = await repository.findMethodById(db, input.shippingMethodId);
    if (!method || !method.enabled) throw PlatformError.notFound('ShippingMethod', input.shippingMethodId);
    return method.freeShippingThresholdCents !== null && input.subtotalCents >= method.freeShippingThresholdCents
      ? 0
      : method.feeCents;
  },

  /**
   * Checkout's deep boundary: resolve a currently enabled, destination-compatible method exactly once.
   * The returned value is a value object that order can freeze without importing shipping fee rules.
   */
  async resolveCheckoutMethod(
    db: DrizzleDb | Tx,
    input: { shippingMethodId: string; subtotalCents: number; destinationKind: ShippingDestinationKind },
  ): Promise<CheckoutShippingMethodSnapshot> {
    if (!Number.isSafeInteger(input.subtotalCents) || input.subtotalCents < 0) {
      throw PlatformError.validation('subtotalCents must be a nonnegative integer');
    }
    const method = await repository.findMethodById(db, input.shippingMethodId);
    if (!method || !method.enabled) throw PlatformError.notFound('ShippingMethod', input.shippingMethodId);
    if (method.destinationKind !== input.destinationKind) {
      throw PlatformError.validation(`Shipping method ${method.id} does not support destination kind ${input.destinationKind}`);
    }
    const shippingCents = method.freeShippingThresholdCents !== null && input.subtotalCents >= method.freeShippingThresholdCents
      ? 0
      : method.feeCents;
    return {
      id: method.id, code: method.code, name: method.name, provider: method.provider, type: method.type,
      destinationKind: method.destinationKind as ShippingDestinationKind, shippingCents,
    };
  },

  /** Order owns cancellation, while Shipping owns whether fulfilment has begun. */
  async hasShipmentForOrder(db: DrizzleDb | Tx, orderId: string): Promise<boolean> {
    return repository.hasShipmentForOrder(db, orderId);
  },

  async createShipment(
    ctx: CommandContext,
    input: { orderId: string; providerRef?: string; trackingNumber?: string },
    orders: ShipmentOrderLookup,
  ): Promise<ShipmentDto> {
    // Fulfilment must replay the checkout snapshot. The merchant may have
    // retired or reconfigured its live method since the customer ordered.
    const delivery = await orders.deliveryForShipment(ctx.tx, input.orderId);
    if (!delivery) throw PlatformError.notFound('Order delivery', input.orderId);
    // `deliveryForShipment` locks Order first. Checking after that lock gives
    // create-shipment and cancel-order one serial decision point.
    if (await repository.hasShipmentForOrder(ctx.tx, input.orderId)) {
      throw PlatformError.conflict(`Order ${input.orderId} already has a shipment`);
    }
    const row = await repository.insertShipment(ctx.tx, {
      id: randomUUID(), orderId: input.orderId, shippingMethodId: delivery.shippingMethodId,
      provider: delivery.provider, type: delivery.type, providerRef: input.providerRef ?? null,
      trackingNumber: input.trackingNumber ?? null, status: 'created', createdAt: ctx.now, updatedAt: ctx.now,
    });
    const dto = toShipmentDto(row);
    await ctx.publish({ name: shipmentCreatedV1.name, payload: { shipmentId: dto.id, orderId: dto.orderId, shippingMethodId: dto.shippingMethodId, occurredAt: ctx.now } });
    return dto;
  },

  /**
   * Saves raw provider evidence privately, then advances the stable domain stage when mapped by an adapter.
   * A callback may update its raw value without representing a public lifecycle transition.
   */
  async recordProviderStatus(
    ctx: CommandContext,
    input: { shipmentId: string; rawStatus: string; stage?: Exclude<ShipmentStatus, 'created'> },
  ): Promise<ShipmentDto> {
    const shipment = await repository.lockShipment(ctx.tx, input.shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', input.shipmentId);
    const updatedRaw = await repository.updateShipment(ctx.tx, shipment.id, { providerStatusRaw: input.rawStatus }, ctx.now);
    if (!input.stage) return toShipmentDto(updatedRaw!);
    return this.advanceStage(ctx, { shipmentId: shipment.id, status: input.stage });
  },

  async advanceStage(ctx: CommandContext, input: { shipmentId: string; status: Exclude<ShipmentStatus, 'created'> }): Promise<ShipmentDto> {
    const shipment = await repository.lockShipment(ctx.tx, input.shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', input.shipmentId);
    const currentIndex = stages.indexOf(shipment.status as ShipmentStatus);
    const nextIndex = stages.indexOf(input.status);
    if (nextIndex < currentIndex) throw PlatformError.conflict(`Shipment ${shipment.id} cannot move backwards from ${shipment.status} to ${input.status}`);
    if (nextIndex === currentIndex) return toShipmentDto(shipment);
    const updated = await repository.updateShipment(ctx.tx, shipment.id, {
      status: input.status,
      [stageTimestamp(input.status)]: ctx.now,
    }, ctx.now);
    const dto = toShipmentDto(updated!);
    const event = stageEvent(input.status);
    await ctx.publish({ name: event.name, payload: { shipmentId: dto.id, orderId: dto.orderId, shippingMethodId: dto.shippingMethodId, occurredAt: ctx.now } });
    return dto;
  },
};
