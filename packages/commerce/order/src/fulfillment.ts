import { PlatformError, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { OrderRepository, toOrderDeliveryDto } from './repository';
import type { ShippingDestinationInput } from '@storeweave/shipping';
import type { InvoiceCarrier, InvoiceIssueInput } from '@storeweave/extension-sdk';
import { invoicePreferenceInput } from './dto';
import { inventoryService } from '@storeweave/inventory';
import { reverseCouponForOrder } from '@storeweave/coupon';
import { rewardService, tierService } from '@storeweave/loyalty';

/**
 * The only shipping-facing projection of an order. Shipping gets the frozen
 * checkout choice, never the order table or the merchant's live method.
 */
export interface OrderDeliveryForShipment {
  readonly shippingMethodId: string;
  readonly serviceCode: string;
  readonly provider: string;
  readonly type: string;
  readonly destination: ShippingDestinationInput;
}

/** Refund's narrow, locked projection of the original successful payment. */
export interface OrderPaymentForRefund {
  readonly orderId: string; readonly customerId: string | null; readonly currency: string; readonly amountCents: number;
  readonly paymentAttemptId: string; readonly paymentAttemptRef: string; readonly paymentProvider: string; readonly paymentProviderRef: string;
}
export interface ReturnableOrderForRma extends OrderPaymentForRefund {
  readonly lines: readonly { id:string; productId:string; sku:string; name:string; quantity:number; unitPriceCents:number; lineTotalCents:number; discountCents:number }[];
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
    const snapshot = toOrderDeliveryDto(delivery);
    return {
      shippingMethodId: delivery.shippingMethodId,
      serviceCode: delivery.shippingMethodCode,
      provider: delivery.provider,
      type: delivery.type,
      destination: snapshot.destination,
    };
  },
};

/**
 * A deliberately tiny read port for customer-facing lifecycle notices.  The
 * notification module receives the durable order snapshot, never direct table
 * access; that keeps recipient lookup an Order concern.
 */
export const orderNotificationService = {
  async recipientForNotification(db: DrizzleDb | Tx, orderId: string): Promise<{ email: string; orderNumber: string } | null> {
    const order = await repository.findById(db, orderId);
    return order ? { email: order.customerEmail, orderNumber: order.number } : null;
  },
};

/**
 * Invoice gets an immutable paid-order projection instead of direct access to
 * order tables. The selected B2C carrier is validated at checkout and read
 * again here from the stored snapshot; a generic metadata value cannot shadow
 * it because checkout overwrites the reserved key.
 */
export const orderInvoiceService = {
  async invoiceForIssue(db: DrizzleDb | Tx, orderId: string): Promise<Omit<InvoiceIssueInput, 'invoiceId' | 'reference'> | null> {
    const order = await repository.findById(db, orderId);
    if (!order || order.status !== 'paid') return null;
    const [lines, delivery] = await Promise.all([repository.linesFor(db, orderId), repository.deliveryFor(db, orderId)]);
    const rawPreference = (order.metadata as Record<string, unknown> | null)?.invoicePreference ?? { kind: 'ecpay' };
    const parsed = invoicePreferenceInput.safeParse(rawPreference);
    if (!parsed.success) throw PlatformError.validation(`Order ${order.number} has an invalid invoice preference`, parsed.error.issues);
    const invoiceLines = lines.map((line) => ({
      name: `${line.name} × ${line.quantity}`.slice(0, 200), quantity: 1,
      unitPriceCents: line.lineTotalCents - line.discountCents, amountCents: line.lineTotalCents - line.discountCents,
    })).filter((line) => line.amountCents > 0);
    if (order.shippingCents > 0) invoiceLines.push({ name: 'Shipping', quantity: 1, unitPriceCents: order.shippingCents, amountCents: order.shippingCents });
    const represented = invoiceLines.reduce((total, line) => total + line.amountCents, 0);
    if (represented < order.totalCents) invoiceLines.push({ name: 'Order adjustment', quantity: 1, unitPriceCents: order.totalCents - represented, amountCents: order.totalCents - represented });
    if (represented > order.totalCents || invoiceLines.length === 0) throw PlatformError.conflict(`Order ${order.number} cannot produce a positive B2C invoice line total`);
    return {
      orderId: order.id, orderNumber: order.number, currency: order.currency, amountCents: order.totalCents, taxCents: 0,
      customer: { email: order.customerEmail, name: delivery?.recipient ?? 'Customer', phone: delivery?.phone ?? '' },
      carrier: parsed.data as InvoiceCarrier, lines: invoiceLines,
    };
  },
};

export const orderRefundService = {
  async paymentForRefund(tx: Tx, orderId: string): Promise<OrderPaymentForRefund> {
    const order = await repository.lockById(tx, orderId);
    if (!order) throw PlatformError.notFound('Order', orderId);
    if (order.status !== 'paid') throw PlatformError.conflict(`Order ${order.number} cannot be refunded (status=${order.status})`);
    const payment = (await repository.paymentsFor(tx, order.id))
      .filter((candidate) => candidate.status === 'succeeded' && candidate.providerRef).at(-1);
    if (!payment?.providerRef) throw PlatformError.conflict(`Order ${order.number} has no successful provider payment to refund`);
    return { orderId: order.id, customerId: order.customerId, currency: order.currency, amountCents: order.totalCents,
      paymentAttemptId: payment.id, paymentAttemptRef: payment.attemptRef, paymentProvider: payment.provider, paymentProviderRef: payment.providerRef };
  },
  /**
   * A successful direct refund reverses the local effects of payment exactly
   * once in the same transaction as the financial fact.  RMA refunds will use
   * their own disposition rule instead of automatically restocking goods.
   */
  async finalizeDirectRefund(ctx: CommandContext, orderId: string): Promise<void> {
    const order = await repository.lockById(ctx.tx, orderId);
    if (!order) throw PlatformError.notFound('Order', orderId);
    const lines = await repository.linesFor(ctx.tx, order.id);
    for (const line of lines) {
      await inventoryService.adjust(ctx, { productId: line.productId, delta: line.quantity, reason: 'refund-restock', reference: `refund:${order.id}` });
    }
    await reverseCouponForOrder(ctx.tx, { orderId: order.id, now: ctx.now });
    if (order.customerId) {
      await rewardService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
      await tierService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
    }
  },
};

/** RMA gets a locked, immutable sale snapshot; it never opens order tables itself. */
export const orderReturnService = {
  async returnableForRma(tx: Tx, orderId: string): Promise<ReturnableOrderForRma> {
    const payment = await orderRefundService.paymentForRefund(tx, orderId);
    const lines = await repository.linesFor(tx, payment.orderId);
    return { ...payment, lines: lines.map((line) => ({ id:line.id,productId:line.productId,sku:line.sku,name:line.name,quantity:line.quantity,unitPriceCents:line.unitPriceCents,lineTotalCents:line.lineTotalCents,discountCents:line.discountCents })) };
  },
};
