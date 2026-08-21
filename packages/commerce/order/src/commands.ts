import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { ProviderRegistry, PaymentProvider } from '@storeweave/extension-sdk';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import { cancelOrderInput, orderDto, payOrderInput, placeOrderInput, type OrderDto } from './dto';
import { OrderRepository, toOrderDto } from './repository';
import { orderCancelledV1, orderPaidV1, orderPlacedV1 } from './events';
import { orderLines, orderPayments, orders } from './schema';

const repository = new OrderRepository();

export interface OrderModuleDeps {
  providers: ProviderRegistry;
  defaultCurrency: string;
  orderNumberPrefix: string;
}

export const placeOrderCommand = defineCommand({
  name: 'commerce.order.placeOrder',
  summary: '建立訂單並扣減庫存',
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
      // 扣庫存透過 inventory 的公開 service，不直接寫對方資料表
      await inventoryService.adjust(ctx, {
        productId: product.id,
        delta: -line.quantity,
        reason: 'order',
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
      updatedAt: ctx.now,
    }).returning();
    const lineRows = await ctx.tx.insert(orderLines).values(lines).returning();

    const dto = toOrderDto(orderRow, lineRows);
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
    return dto;
  };
}

export const payOrderCommand = defineCommand({
  name: 'commerce.order.payOrder',
  summary: '透過 payment provider 收款並標記訂單已付款',
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

    if (order.status === 'paid') return toOrderDto(order, lineRows);
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be paid (status=${order.status})`);
    }

    const provider = deps.providers.get<PaymentProvider>('payment', input.provider);
    // reference 讓 provider 自己去重；命令層的 Idempotency Key 則保護重複請求
    const result = await provider.charge({
      orderId: order.id,
      orderNumber: order.number,
      amountCents: order.totalCents,
      currency: order.currency,
      reference: `order:${order.id}`,
    });
    if (result.status !== 'succeeded') {
      throw PlatformError.conflict(`Payment failed: ${result.message ?? 'declined'}`);
    }

    await ctx.tx.insert(orderPayments).values({
      id: randomUUID(),
      orderId: order.id,
      provider: provider.id,
      providerRef: result.providerRef,
      amountCents: order.totalCents,
      status: 'succeeded',
      createdAt: ctx.now,
    });

    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'paid', paidAt: ctx.now, updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();

    const dto = toOrderDto(updated, lineRows);
    // 與訂單狀態寫在同一個交易 —— 事件進 Outbox 不可能與訂單狀態不一致
    await ctx.publish({
      name: orderPaidV1.name,
      payload: {
        orderId: dto.id,
        orderNumber: dto.number,
        customerEmail: dto.customerEmail,
        currency: dto.currency,
        totalCents: dto.totalCents,
        paidAt: dto.paidAt!,
        paymentProvider: provider.id,
        paymentRef: result.providerRef,
        lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents }) => ({
          productId, sku, name, quantity, unitPriceCents, lineTotalCents,
        })),
      },
    });
    return dto;
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
      await inventoryService.adjust(ctx, {
        productId: line.productId,
        delta: line.quantity,
        reason: 'order-cancelled',
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
