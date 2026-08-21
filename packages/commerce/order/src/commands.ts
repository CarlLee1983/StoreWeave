import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { ProviderRegistry, PaymentProvider } from '@storeweave/extension-sdk';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import { cancelOrderInput, markPaidInput, orderDto, payOrderInput, placeOrderInput, type OrderDto } from './dto';
import { OrderRepository, toOrderDto } from './repository';
import { orderCancelledV1, orderPaidV1, orderPlacedV1, orderPlacedV2 } from './events';
import { orderLines, orderPayments, orders } from './schema';

const repository = new OrderRepository();

export interface OrderModuleDeps {
  providers: ProviderRegistry;
  defaultCurrency: string;
  orderNumberPrefix: string;
}

export const PROCESS_PAYMENT_JOB = 'commerce.order.process-payment';
export const EXPIRE_ORDER_JOB = 'commerce.order.expire-reservation';
const RESERVATION_MINUTES = 15;

export const placeOrderCommand = defineCommand({
  name: 'commerce.order.placeOrder',
  summary: '建立訂單並預留庫存',
  input: placeOrderInput,
  output: orderDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: {
    action: 'order.placed',
    resourceType: 'order',
    resourceId: (_i, o: OrderDto) => o.id,
    redact: (i) => ({ lineCount: i.lines.length }),
  },
});

export function createPlaceOrderHandler(deps: OrderModuleDeps) {
  return async (input: z.infer<typeof placeOrderInput>, ctx: CommandContext): Promise<OrderDto> => {
    const orderId = randomUUID();
    const number = await repository.nextOrderNumber(ctx.tx, deps.orderNumberPrefix);
    const currency = input.currency ?? deps.defaultCurrency;

    const lines: (typeof orderLines.$inferInsert)[] = [];
    for (const line of input.lines) {
      const product = await catalogService.requireActiveProduct(ctx.tx, line.productId);
      if (product.currency !== currency) {
        throw PlatformError.validation(`Product ${product.sku} is priced in ${product.currency}, order is ${currency}`);
      }
      await inventoryService.reserve(ctx, {
        productId: product.id,
        quantity: line.quantity,
        reference: number,
      });
      lines.push({
        id: randomUUID(),
        orderId,
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: line.quantity,
        lineTotalCents: product.priceCents * line.quantity,
      });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const expiresAt = new Date(ctx.now.getTime() + RESERVATION_MINUTES * 60_000);
    const [orderRow] = await ctx.tx.insert(orders).values({
      id: orderId,
      number,
      status: 'pending',
      currency,
      customerEmail: input.customerEmail,
      subtotalCents: subtotal,
      totalCents: subtotal,
      metadata: input.metadata ?? null,
      placedAt: ctx.now,
      expiresAt,
      updatedAt: ctx.now,
    }).returning();
    const lineRows = await ctx.tx.insert(orderLines).values(lines).returning();

    const dto = toOrderDto(orderRow, lineRows);
    await ctx.enqueue({ type: EXPIRE_ORDER_JOB, payload: { orderId }, dedupeKey: `order:expire:${orderId}`, runAt: expiresAt });
    await ctx.publish({
      name: orderPlacedV1.name,
      payload: {
        orderId: dto.id,
        orderNumber: dto.number,
        customerEmail: dto.customerEmail,
        currency: dto.currency,
        totalCents: dto.totalCents,
        placedAt: dto.placedAt,
        lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents }) => ({
          productId, sku, name, quantity, unitPriceCents, lineTotalCents,
        })),
      },
    });
    await ctx.publish({
      name: orderPlacedV2.name,
      payload: { orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, currency: dto.currency,
        totalCents: dto.totalCents, placedAt: dto.placedAt, expiresAt: expiresAt,
        lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents }) => ({ productId, sku, name, quantity, unitPriceCents, lineTotalCents })), },
    });
    return dto;
  };
}

export const payOrderCommand = defineCommand({
  name: 'commerce.order.payOrder',
  summary: '要求背景工作向 payment provider 收款',
  input: payOrderInput,
  output: orderDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: { action: 'order.paid', resourceType: 'order', resourceId: (i) => i.orderId },
});

export function createPayOrderHandler(deps: OrderModuleDeps) {
  return async (input: z.infer<typeof payOrderInput>, ctx: CommandContext): Promise<OrderDto> => {
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const lineRows = await repository.linesFor(ctx.tx, order.id);

    if (order.status === 'paid' || order.status === 'payment_processing') return toOrderDto(order, lineRows);
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be paid (status=${order.status})`);
    }
    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'payment_processing', updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();
    const provider = deps.providers.get<PaymentProvider>('payment', input.provider);
    await ctx.enqueue({ type: PROCESS_PAYMENT_JOB, payload: { orderId: order.id, orderNumber: order.number, amountCents: order.totalCents, currency: order.currency, provider: provider.id }, dedupeKey: `order:pay:${order.id}` });
    return toOrderDto(updated, lineRows);
  };
}

export const markPaidCommand = defineCommand({
  name: 'commerce.order.markPaid', summary: '確認背景付款成功並扣除已預留庫存', input: markPaidInput, output: orderDto,
  permission: 'order:write', idempotency: 'required', audit: { action: 'order.paid', resourceType: 'order', resourceId: (i) => i.orderId },
});

export const expireOrderCommand = defineCommand({
  name: 'commerce.order.expireOrder', summary: '釋放逾時未付款訂單的庫存預留',
  input: z.object({ orderId: z.string().uuid() }), output: orderDto, permission: 'order:write', idempotency: 'required',
  audit: { action: 'order.expired', resourceType: 'order', resourceId: (i) => i.orderId },
});

export function createExpireOrderHandler() {
  return async (input: { orderId: string }, ctx: CommandContext): Promise<OrderDto> => {
    if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only the worker may expire an order');
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const lines = await repository.linesFor(ctx.tx, order.id);
    if (order.status === 'expired') return toOrderDto(order, lines);
    if (order.status === 'paid' || order.status === 'cancelled') return toOrderDto(order, lines);
    if (!order.expiresAt || order.expiresAt.getTime() > ctx.now.getTime()) {
      throw PlatformError.conflict(`Order ${order.number} has not reached its payment deadline`);
    }
    for (const line of lines) await inventoryService.release(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
    const [updated] = await ctx.tx.update(orders).set({ status: 'expired', updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    return toOrderDto(updated, lines);
  };
}

export function createMarkPaidHandler() {
  return async (input: z.infer<typeof markPaidInput>, ctx: CommandContext): Promise<OrderDto> => {
    if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only a payment worker may confirm payment');
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const lines = await repository.linesFor(ctx.tx, order.id);
    if (order.status === 'paid') return toOrderDto(order, lines);
    if (order.status !== 'payment_processing') throw PlatformError.conflict(`Order ${order.number} cannot be marked paid (status=${order.status})`);
    // 唯一鍵衝突必須使整筆交易回滾：同一 provider ref 絕不能支付兩張訂單。
    await ctx.tx.insert(orderPayments).values({ id: randomUUID(), orderId: order.id, provider: input.provider, providerRef: input.providerRef, amountCents: order.totalCents, status: 'succeeded', createdAt: ctx.now });
    for (const line of lines) await inventoryService.commitReservation(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
    const [updated] = await ctx.tx.update(orders).set({ status: 'paid', paidAt: ctx.now, updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    const dto = toOrderDto(updated, lines);
    await ctx.publish({ name: orderPaidV1.name, payload: { orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, currency: dto.currency, totalCents: dto.totalCents, paidAt: dto.paidAt!, paymentProvider: input.provider, paymentRef: input.providerRef, lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents }) => ({ productId, sku, name, quantity, unitPriceCents, lineTotalCents })) } });
    return dto;
  };
}

type CoreJobContext = {
  executeCommand(name: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  executeQuery(name: string, input: unknown): Promise<any>;
};

export function createProcessPaymentJob(deps: OrderModuleDeps) {
  return async (raw: unknown, rawCtx: unknown): Promise<void> => {
    const { orderId, orderNumber, amountCents, currency, provider: providerId } = z.object({ orderId: z.string().uuid(), orderNumber: z.string(), amountCents: z.number().int(), currency: z.string(), provider: z.string() }).parse(raw);
    const ctx = rawCtx as CoreJobContext;
    const current = await ctx.executeQuery('commerce.order.getOrder', { id: orderId });
    if (current.status !== 'payment_processing') return;
    if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
      await ctx.executeCommand('commerce.order.expireOrder', { orderId }, `expire-order:${orderId}`);
      return;
    }
    const provider = deps.providers.get<PaymentProvider>('payment', providerId);
    // Job 執行在交易外；provider 的 reference 冪等，worker 重試不會重複扣款。
    const result = await provider.charge({ orderId, orderNumber, amountCents, currency, reference: `order:${orderId}` });
    if (result.status !== 'succeeded') throw new Error(`Payment failed: ${result.message ?? 'declined'}`);
    await ctx.executeCommand('commerce.order.markPaid', { orderId, provider: provider.id, providerRef: result.providerRef }, `mark-paid:${provider.id}:${result.providerRef}`);
  };
}

export function createExpireReservationJob() {
  return async (raw: unknown, rawCtx: unknown): Promise<void> => {
    const { orderId } = z.object({ orderId: z.string().uuid() }).parse(raw);
    const ctx = rawCtx as CoreJobContext;
    await ctx.executeCommand('commerce.order.expireOrder', { orderId }, `expire-order:${orderId}`);
  };
}

export const cancelOrderCommand = defineCommand({
  name: 'commerce.order.cancelOrder',
  summary: '取消訂單並回補庫存',
  input: cancelOrderInput,
  output: orderDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: { action: 'order.cancelled', resourceType: 'order', resourceId: (i) => i.orderId, redact: (i) => ({ reason: i.reason }) },
});

export function createCancelOrderHandler(_deps: OrderModuleDeps) {
  return async (input: z.infer<typeof cancelOrderInput>, ctx: CommandContext): Promise<OrderDto> => {
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const lineRows = await repository.linesFor(ctx.tx, order.id);
    if (order.status === 'cancelled') return toOrderDto(order, lineRows);
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be cancelled (status=${order.status})`);
    }

    for (const line of lineRows) {
      await inventoryService.release(ctx, {
        productId: line.productId,
        quantity: line.quantity,
        reference: order.number,
      });
    }

    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'cancelled', cancelledAt: ctx.now, updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();

    const dto = toOrderDto(updated, lineRows);
    await ctx.publish({
      name: orderCancelledV1.name,
      payload: {
        orderId: dto.id,
        orderNumber: dto.number,
        reason: input.reason,
        cancelledAt: dto.cancelledAt!,
        restockedLines: lineRows.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      },
    });
    return dto;
  };
}
