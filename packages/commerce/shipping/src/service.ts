import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlatformError, type Actor, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import type { ShippingProvider } from '@storeweave/extension-sdk';
import { cartService } from '@storeweave/cart';
import { customerService } from '@storeweave/customer';
import { shipmentArrivedV1, shipmentCompletedV1, shipmentCreatedV1, shipmentShippedV1 } from './events';
import {
  ShippingRepository, toProviderShipmentRequestDto, toProviderShipmentStatusRequestDto, toShipmentDto, toShipmentLabelInfoDto,
} from './repository';
import type {
  CheckoutShippingMethodSnapshot, ProviderShipmentRequestDto, ProviderShipmentStatusRequestDto, ShipmentDto, ShipmentLabelInfoDto,
  ShipmentStatus, ShippingDestinationInput, ShippingDestinationKind,
  PickupSelectionViewDto,
} from './dto';

const repository = new ShippingRepository();
const stages: ShipmentStatus[] = ['created', 'shipped', 'arrived', 'completed'];
const PICKUP_SELECTION_TTL_MS = 10 * 60 * 1000;

function pickupTokenHash(token: string): string {
  return createHash('sha256').update(`pickup-selection:${token}`).digest('base64url');
}

function assertLivePickupSelection(selection: { expiresAt: Date; consumedAt: Date | null }, now: Date): void {
  if (selection.consumedAt) throw PlatformError.conflict('This pickup selection has already been used');
  if (selection.expiresAt <= now) throw PlatformError.validation('This pickup selection has expired; please select a store again');
}

/** Cross-module port; the bundle wires it to order's narrow fulfillment projection. */
export interface ShipmentOrderLookup {
  deliveryForShipment(tx: Tx, orderId: string): Promise<{
    readonly shippingMethodId: string;
    readonly serviceCode: string;
    readonly provider: string;
    readonly type: string;
    readonly destination: ShippingDestinationInput;
  } | null>;
}
export interface ShipmentRefundGuard { hasBlockingDirectRefund(tx: Tx, orderId: string): Promise<boolean>; }

function stageTimestamp(status: Exclude<ShipmentStatus, 'created'>): 'shippedAt' | 'arrivedAt' | 'completedAt' {
  return status === 'shipped' ? 'shippedAt' : status === 'arrived' ? 'arrivedAt' : 'completedAt';
}

function stageEvent(status: Exclude<ShipmentStatus, 'created'>) {
  return status === 'shipped' ? shipmentShippedV1 : status === 'arrived' ? shipmentArrivedV1 : shipmentCompletedV1;
}

/** The reference is stable across event replay, job retry, and a worker crash. */
function providerRequestReference(shipmentId: string): string {
  return `shipment:${shipmentId}`;
}

/** RBAC grants the capability; an extension actor is additionally bound to its declared carrier id. */
function assertCarrierOwner(actor: Actor, provider: string, owner: string | null): void {
  if (actor.type !== 'extension') return;
  // A provider name in an extension manifest is only a declaration. The
  // shipment freezes the registry owner that was configured when it was
  // created, so an extension mounted later cannot claim `manual` or a legacy
  // provider id to obtain delivery PII.
  if (!owner || actor.extensionId !== owner || !actor.providerBindings?.includes(`shipping:${provider}`)) {
    throw PlatformError.forbidden(`Extension "${actor.extensionId ?? actor.id}" cannot access shipping provider "${provider}"`);
  }
}

function shippingProviderOwner(providers: ProviderRegistry, provider: string): string | null {
  return providers.list().find((entry) => entry.kind === 'shipping' && entry.id === provider)?.owner ?? null;
}

/** The only cross-module interface for merchant policy and shipment lifecycle. */
export const shippingService = {
  /** Creates a hash-only capability bound to the signed-in customer's still-open cart and method. */
  async beginPickupSelection(
    ctx: CommandContext,
    input: { cartId: string; shippingMethodId: string },
    providers: ProviderRegistry,
  ): Promise<{ token: string; expiresAt: Date }> {
    const buyer = await customerService.requireByActor(ctx.tx, ctx.actor);
    const cart = await cartService.lockOpenForCustomer(ctx.tx, input.cartId, buyer.customerId);
    if (!cart) throw PlatformError.notFound('Cart', input.cartId);
    const method = await repository.findMethodById(ctx.tx, input.shippingMethodId);
    if (!method || !method.enabled || method.destinationKind !== 'pickup_store') {
      throw PlatformError.validation('This shipping method does not support convenience-store pickup');
    }
    const provider = providers.get<ShippingProvider>('shipping', method.provider);
    if (!provider.pickupStores) throw PlatformError.validation('This shipping method does not have a store picker');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(ctx.now.getTime() + PICKUP_SELECTION_TTL_MS);
    await repository.insertPickupSelection(ctx.tx, {
      id: randomUUID(), tokenHash: pickupTokenHash(token), cartId: cart.id, customerId: buyer.customerId,
      shippingMethodId: method.id, provider: method.provider, type: method.type, expiresAt,
      createdAt: ctx.now, updatedAt: ctx.now,
    });
    return { token, expiresAt };
  },

  /** Cross-site callbacks present only the opaque capability and a provider store id. */
  async completePickupSelection(
    ctx: CommandContext,
    input: { token: string; providerStoreId: string },
    providers: ProviderRegistry,
  ): Promise<{ expiresAt: Date }> {
    const selection = await repository.lockPickupSelectionByHash(ctx.tx, pickupTokenHash(input.token));
    if (!selection) throw PlatformError.notFound('Pickup selection', 'token');
    assertLivePickupSelection(selection, ctx.now);
    const provider = providers.get<ShippingProvider>('shipping', selection.provider);
    if (!provider.pickupStores) throw PlatformError.validation('This shipping provider does not support store selection');
    const store = (await provider.pickupStores({ serviceType: selection.type }))
      .find((candidate) => candidate.providerStoreId === input.providerStoreId);
    if (!store) throw PlatformError.validation('The selected convenience store is not available for this shipping method');
    await repository.updatePickupSelection(ctx.tx, selection.id, {
      providerStoreId: store.providerStoreId, storeName: store.storeName, storeAddress: store.storeAddress,
    }, ctx.now);
    return { expiresAt: selection.expiresAt };
  },

  /** Read path for the customer checkout page; it never changes one-time state. */
  async pickupSelectionView(
    db: DrizzleDb | Tx,
    input: { token: string; cartId: string; customerId: string; shippingMethodId?: string },
  ): Promise<PickupSelectionViewDto> {
    const selection = await repository.findPickupSelectionByHash(db, pickupTokenHash(input.token));
    if (!selection || selection.cartId !== input.cartId || selection.customerId !== input.customerId || (input.shippingMethodId && selection.shippingMethodId !== input.shippingMethodId)) {
      throw PlatformError.notFound('Pickup selection', 'token');
    }
    assertLivePickupSelection(selection, new Date());
    return {
      token: input.token, shippingMethodId: selection.shippingMethodId, provider: selection.provider, type: selection.type,
      expiresAt: selection.expiresAt,
      store: selection.providerStoreId && selection.storeName && selection.storeAddress
        ? { providerStoreId: selection.providerStoreId, storeName: selection.storeName, storeAddress: selection.storeAddress }
        : null,
    };
  },

  /** Called from Order's transaction so Cart checkout and single use consume together. */
  async consumePickupSelection(
    tx: Tx,
    input: { token: string; cartId: string; customerId: string; shippingMethodId: string; recipient: string; phone: string },
    now: Date,
  ): Promise<ShippingDestinationInput> {
    const selection = await repository.lockPickupSelectionByHash(tx, pickupTokenHash(input.token));
    if (!selection || selection.cartId !== input.cartId || selection.customerId !== input.customerId || selection.shippingMethodId !== input.shippingMethodId) {
      throw PlatformError.notFound('Pickup selection', 'token');
    }
    assertLivePickupSelection(selection, now);
    if (!selection.providerStoreId || !selection.storeName || !selection.storeAddress) {
      throw PlatformError.validation('Please choose a convenience store before checkout');
    }
    await repository.updatePickupSelection(tx, selection.id, { consumedAt: now }, now);
    return {
      kind: 'pickup_store', providerStoreId: selection.providerStoreId, storeName: selection.storeName,
      storeAddress: selection.storeAddress, recipient: input.recipient, phone: input.phone,
    };
  },
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

  /** RMA eligibility deliberately excludes locally-created labels. */
  async hasReturnableShipment(db: DrizzleDb | Tx, orderId: string): Promise<boolean> {
    return repository.hasReturnableShipment(db, orderId);
  },

  async createShipment(
    ctx: CommandContext,
    input: { orderId: string; providerRef?: string; trackingNumber?: string },
    orders: ShipmentOrderLookup,
    providers: ProviderRegistry,
    refunds?: ShipmentRefundGuard,
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
    // The order lock taken by `deliveryForShipment` serializes this check with
    // direct-refund request/retry, which takes that same lock first.
    if (refunds && await refunds.hasBlockingDirectRefund(ctx.tx, input.orderId)) {
      throw PlatformError.conflict(`Order ${input.orderId} has a direct refund in progress or completed`);
    }
    const shipmentId = randomUUID();
    const row = await repository.insertShipment(ctx.tx, {
      id: shipmentId, orderId: input.orderId, shippingMethodId: delivery.shippingMethodId,
      provider: delivery.provider, type: delivery.type, serviceCode: delivery.serviceCode,
      destinationSnapshot: delivery.destination, providerRequestRef: providerRequestReference(shipmentId),
      providerOwner: shippingProviderOwner(providers, delivery.provider),
      providerRef: input.providerRef ?? null, trackingNumber: input.trackingNumber ?? null,
      status: 'created', createdAt: ctx.now, updatedAt: ctx.now,
    });
    const dto = toShipmentDto(row);
    await ctx.publish({ name: shipmentCreatedV1.name, payload: { shipmentId: dto.id, orderId: dto.orderId, shippingMethodId: dto.shippingMethodId, occurredAt: ctx.now } });
    return dto;
  },

  /**
   * A provider extension reads this after the local shipment-created outbox
   * event is delivered. The request comes from the frozen checkout snapshot,
   * never from a merchant's mutable shipping-method settings.
   */
  async providerShipmentRequest(db: DrizzleDb | Tx, shipmentId: string, actor: Actor): Promise<ProviderShipmentRequestDto> {
    const shipment = await repository.findShipmentById(db, shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', shipmentId);
    assertCarrierOwner(actor, shipment.provider, shipment.providerOwner);
    return toProviderShipmentRequestDto(shipment);
  },

  /** Carrier-only status request with no delivery PII. */
  async providerShipmentStatusRequest(db: DrizzleDb | Tx, shipmentId: string, actor: Actor): Promise<ProviderShipmentStatusRequestDto> {
    const shipment = await repository.findShipmentById(db, shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', shipmentId);
    assertCarrierOwner(actor, shipment.provider, shipment.providerOwner);
    return toProviderShipmentStatusRequestDto(shipment);
  },

  /**
   * Writes only a matching adapter's immutable create result. Replays are safe
   * when they repeat the same values; a conflicting remote result is surfaced
   * for operations instead of silently overwriting shipment evidence.
   */
  async recordProviderShipment(
    ctx: CommandContext,
    input: {
      shipmentId: string;
      provider: string;
      reference: string;
      providerRef: string;
      trackingNumber?: string;
      labelReference?: string;
    },
  ): Promise<ShipmentDto> {
    const shipment = await repository.lockShipment(ctx.tx, input.shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', input.shipmentId);
    if (shipment.provider !== input.provider) {
      throw PlatformError.conflict(`Shipment ${shipment.id} belongs to provider ${shipment.provider}, not ${input.provider}`);
    }
    assertCarrierOwner(ctx.actor, shipment.provider, shipment.providerOwner);
    if (!shipment.providerRequestRef || shipment.providerRequestRef !== input.reference) {
      throw PlatformError.conflict(`Shipment ${shipment.id} does not match the carrier request reference`);
    }

    const assertSame = (field: string, current: string | null, next: string | undefined) => {
      if (current && next && current !== next) {
        throw PlatformError.conflict(`Shipment ${shipment.id} already has a different ${field}`);
      }
    };
    assertSame('providerRef', shipment.providerRef, input.providerRef);
    assertSame('trackingNumber', shipment.trackingNumber, input.trackingNumber);
    assertSame('labelReference', shipment.labelReference, input.labelReference);

    const updated = await repository.updateShipment(ctx.tx, shipment.id, {
      providerRef: shipment.providerRef ?? input.providerRef,
      trackingNumber: shipment.trackingNumber ?? input.trackingNumber ?? null,
      labelReference: shipment.labelReference ?? input.labelReference ?? null,
    }, ctx.now);
    return toShipmentDto(updated!);
  },

  /** A future back-office download flow receives an opaque handle only after authorisation. */
  async shipmentLabelInfo(db: DrizzleDb | Tx, shipmentId: string): Promise<ShipmentLabelInfoDto> {
    const shipment = await repository.findShipmentById(db, shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', shipmentId);
    return toShipmentLabelInfoDto(shipment);
  },

  /**
   * Saves raw provider evidence privately, then advances the stable domain stage when mapped by an adapter.
   * A callback may update its raw value without representing a public lifecycle transition.
   */
  async recordProviderStatus(
    ctx: CommandContext,
    input: { shipmentId: string; provider: string; rawStatus: string; stage?: Exclude<ShipmentStatus, 'created'> },
  ): Promise<ShipmentDto> {
    const shipment = await repository.lockShipment(ctx.tx, input.shipmentId);
    if (!shipment) throw PlatformError.notFound('Shipment', input.shipmentId);
    if (shipment.provider !== input.provider) {
      throw PlatformError.conflict(`Shipment ${shipment.id} belongs to provider ${shipment.provider}, not ${input.provider}`);
    }
    assertCarrierOwner(ctx.actor, shipment.provider, shipment.providerOwner);
    const updatedRaw = await repository.updateShipment(ctx.tx, shipment.id, { providerStatusRaw: input.rawStatus }, ctx.now);
    if (!input.stage) return toShipmentDto(updatedRaw!);
    const currentIndex = stages.indexOf(shipment.status as ShipmentStatus);
    const nextIndex = stages.indexOf(input.stage);
    // Carrier queries may arrive late or out of order. Keep their latest raw
    // evidence, but never retry a backward lifecycle mapping indefinitely.
    if (nextIndex <= currentIndex) return toShipmentDto(updatedRaw!);
    return this.advanceStage(ctx, { shipmentId: shipment.id, status: input.stage });
  },

  /**
   * This is intentionally the only callback path that resolves a shipment by
   * carrier reference. The HTTP controller invokes it as SYSTEM only after the
   * registered provider has verified the raw bytes; extensions still use the
   * carrier-bound `recordProviderStatus` command above.
   */
  async recordProviderCallback(
    ctx: CommandContext,
    input: { provider: string; providerRef: string; rawStatus: string; callbackPayloadBase64: string; stage?: Exclude<ShipmentStatus, 'created'>; trackingUrl?: string },
  ): Promise<ShipmentDto> {
    const found = await repository.findShipmentByProviderRef(ctx.tx, input.provider, input.providerRef);
    if (!found) throw PlatformError.notFound('Shipment provider reference');
    const shipment = await repository.lockShipment(ctx.tx, found.id);
    if (!shipment) throw PlatformError.notFound('Shipment', found.id);
    // System is only admitted by the generic callback controller after parsing
    // succeeds. Extension actors remain bound to the frozen carrier owner.
    if (ctx.actor.type !== 'system') assertCarrierOwner(ctx.actor, shipment.provider, shipment.providerOwner);
    const updatedRaw = await repository.updateShipment(ctx.tx, shipment.id, {
      providerStatusRaw: input.rawStatus,
      providerCallbackRaw: input.callbackPayloadBase64,
      ...(input.trackingUrl && !shipment.trackingUrl ? { trackingUrl: input.trackingUrl } : {}),
    }, ctx.now);
    if (!input.stage) return toShipmentDto(updatedRaw!);
    const currentIndex = stages.indexOf(shipment.status as ShipmentStatus);
    const nextIndex = stages.indexOf(input.stage);
    if (nextIndex <= currentIndex) return toShipmentDto(updatedRaw!);
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
