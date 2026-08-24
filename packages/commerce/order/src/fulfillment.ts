import { PlatformError, type Tx } from '@storeweave/contracts';
import { OrderRepository } from './repository';

/**
 * The only shipping-facing projection of an order. Shipping gets the frozen
 * checkout choice, never the order table or the merchant's live method.
 */
export interface OrderDeliveryForShipment {
  readonly shippingMethodId: string;
  readonly provider: string;
  readonly type: string;
}

const repository = new OrderRepository();

export const orderFulfillmentService = {
  async deliveryForShipment(tx: Tx, orderId: string): Promise<OrderDeliveryForShipment | null> {
    // Shipping creation and customer cancellation both take this lock first.
    // Once a cancellation wins, no later shipment may be recorded against it.
    const order = await repository.lockById(tx, orderId);
    if (!order) return null;
    // This checkout flow reserves inventory before payment. It has no COD
    // capability, so allowing an unpaid order to create a shipment would let
    // expiry release stock beneath an already-created fulfilment record.
    if (order.status !== 'paid') {
      throw PlatformError.conflict(`Order ${order.number} cannot enter fulfilment (status=${order.status})`);
    }
    const delivery = await repository.deliveryFor(tx, orderId);
    if (!delivery) return null;
    return {
      shippingMethodId: delivery.shippingMethodId,
      provider: delivery.provider,
      type: delivery.type,
    };
  },
};
