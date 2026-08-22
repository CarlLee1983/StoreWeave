import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { ProviderRegistry, PaymentProvider } from '@storeweave/extension-sdk';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import { customerService } from '@storeweave/customer';
import { pricingService } from '@storeweave/promotion';
import { CartRepository } from '@storeweave/cart';
import { CouponRepository, couponError, couponService } from '@storeweave/coupon';
import { cancelOrderInput, checkoutCartInput, markPaidInput, orderDto, payOrderInput, placeOrderInput, type OrderDto } from './dto';
import { OrderRepository, toOrderDto } from './repository';
import { orderCancelledV1, orderPaidV1, orderPaidV2, orderPlacedV1, orderPlacedV2, orderPlacedV3 } from './events';
import { orderAdjustments, orderLines, orderPayments, orders } from './schema';

const repository = new OrderRepository();

/**
 * 讀取路徑（工單 12）已經擋住「猜訂單號讀別人的訂單」，寫入路徑必須套用同一個不變式。
 * 顧客身分只能動自己的訂單；後台角色與 system 不受限。回 notFound 而不是 forbidden，
 * 理由與查詢相同：後者會變成「這張單存不存在」的 oracle。
 */
async function assertOwnedByActor(ctx: CommandContext, order: { id: string; customerId: string | null }): Promise<void> {
  if (ctx.actor.type !== 'customer') return;
  const customerId = await customerService.customerIdOf(ctx.tx, ctx.actor);
  if (order.customerId !== customerId) throw PlatformError.notFound('Order', order.id);
}

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

/**
 * 建立訂單的唯一實作。`placeOrder` 與 `checkoutCart` 都走這裡——
 * 兩條路各寫一次定價與預留，遲早會有一條算出不同的金額。
 */
export async function createOrderFromLines(
  deps: OrderModuleDeps,
  input: {
    currency?: string;
    lines: { productId: string; quantity: number }[];
    metadata?: Record<string, unknown>;
    /** 券指名的活動。它們不在「此刻人人適用」的清單裡，必須明確帶進來。 */
    couponPromotionIds?: readonly string[];
  },
  ctx: CommandContext,
): Promise<OrderDto> {
  const orderId = randomUUID();
  // 下單者取自當下身分，不再是表單上自由填寫的 email：一張訂單的歸屬不該由呼叫端自己宣稱。
  const buyer = await customerService.requireByActor(ctx.tx, ctx.actor);
  const number = await repository.nextOrderNumber(ctx.tx, deps.orderNumberPrefix);
  const currency = input.currency ?? deps.defaultCurrency;

  const lines: (typeof orderLines.$inferInsert)[] = [];
  for (const line of input.lines) {
    const product = await catalogService.requireActiveProduct(ctx.tx, line.productId);
    if (product.currency !== currency) {
      throw PlatformError.validation(`Product ${product.sku} is priced in ${product.currency}, order is ${currency}`);
    }
    // 預留失敗的訊息必須說得出是哪一件商品：顧客拿到 uuid 沒辦法決定要調整什麼。
    try {
      await inventoryService.reserve(ctx, {
        productId: product.id,
        quantity: line.quantity,
        reference: number,
      });
    } catch (err) {
      if (!(err instanceof PlatformError) || err.code !== 'CONFLICT') throw err;
      const available = await inventoryService.availableFor(ctx.tx, product.id).catch(() => null);
      throw PlatformError.conflict(
        `Insufficient stock for ${product.sku} (${product.name}): ${available ?? 0} available, ${line.quantity} requested`,
      );
    }
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

  // 定價與訂單建立在同一個交易內：折扣依據的活動狀態與寫進訂單的金額必定一致。
  const pricing = await pricingService.quote(ctx.tx, {
    couponPromotionIds: input.couponPromotionIds,
    lines: lines.map((l) => ({
      lineId: l.id!,
      productId: l.productId,
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
    })),
    now: ctx.now,
    logger: ctx.logger,
  });
  const discountByLine = new Map(pricing.lines.map((l) => [l.lineId, l.discountCents]));
  for (const line of lines) line.discountCents = discountByLine.get(line.id!) ?? 0;

  const expiresAt = new Date(ctx.now.getTime() + RESERVATION_MINUTES * 60_000);
  const [orderRow] = await ctx.tx.insert(orders).values({
    id: orderId,
    number,
    status: 'pending',
    currency,
    customerEmail: buyer.email,
    customerId: buyer.customerId,
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    totalCents: pricing.totalCents,
    metadata: input.metadata ?? null,
    placedAt: ctx.now,
    expiresAt,
    updatedAt: ctx.now,
  }).returning();
  const lineRows = await ctx.tx.insert(orderLines).values(lines).returning();
  const adjustmentRows = pricing.adjustments.length === 0 ? [] : await ctx.tx.insert(orderAdjustments).values(
    pricing.adjustments.map((adjustment, index) => ({
      id: randomUUID(),
      orderId,
      source: adjustment.source,
      sourceId: adjustment.sourceId,
      name: adjustment.name,
      amountCents: adjustment.amountCents,
      sortOrder: index,
    })),
  ).returning();

  const dto = toOrderDto(orderRow, lineRows, adjustmentRows);
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
  await ctx.publish({
    name: orderPlacedV3.name,
    payload: { orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, customerId: dto.customerId,
      currency: dto.currency, placedAt: dto.placedAt, expiresAt: expiresAt,
      subtotalCents: dto.subtotalCents, discountCents: dto.discountCents, shippingCents: dto.shippingCents,
      taxCents: dto.taxCents, totalCents: dto.totalCents, adjustments: dto.adjustments,
      lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents }) => ({
        productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents, netCents: lineTotalCents - discountCents,
      })), },
  });
  return dto;
}

export function createPlaceOrderHandler(deps: OrderModuleDeps) {
  return (input: z.infer<typeof placeOrderInput>, ctx: CommandContext): Promise<OrderDto> =>
    createOrderFromLines(deps, input, ctx);
}

const cartRepository = new CartRepository();
const couponRepository = new CouponRepository();

export const checkoutCartCommand = defineCommand({
  name: 'commerce.order.checkoutCart',
  summary: '把購物車轉成訂單',
  input: checkoutCartInput,
  output: orderDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: {
    action: 'order.placed',
    resourceType: 'order',
    resourceId: (_i, o: OrderDto) => o.id,
    redact: () => ({}),
  },
});

/**
 * 購物車結帳。冪等的來源是購物車本身：先鎖住那一列，已經結過就回同一張訂單。
 * 呼叫端帶什麼冪等鍵都不影響這個保證——重複送出的表單本來就不會帶對 key，
 * 而每次現產一個隨機值等於沒有保護（Spec 0003 要修的就是這個缺陷）。
 */
export function createCheckoutCartHandler(deps: OrderModuleDeps) {
  return async (input: z.infer<typeof checkoutCartInput>, ctx: CommandContext): Promise<OrderDto> => {
    const buyer = await customerService.requireByActor(ctx.tx, ctx.actor);
    const cart = await cartRepository.lockById(ctx.tx, input.cartId);
    // 別人的車、或還沒併進來的訪客車，都不是這個人結得了的。
    if (!cart || cart.customerId !== buyer.customerId) throw PlatformError.notFound('Cart', input.cartId);

    if (cart.orderId) {
      const existing = await repository.findById(ctx.tx, cart.orderId);
      if (existing) {
        return toOrderDto(
          existing,
          await repository.linesFor(ctx.tx, existing.id),
          await repository.adjustmentsFor(ctx.tx, existing.id),
        );
      }
    }
    if (cart.status !== 'open') throw PlatformError.conflict(`Cart ${cart.id} is no longer open`);

    // 券在這裡鎖住並重驗：試算到結帳之間它可能過期或被停用，
    // 而顧客看到的金額必須是實際會扣的金額。
    const coupon = cart.couponCode ? await couponRepository.findByCode(ctx.tx, cart.couponCode) : null;
    const locked = coupon ? await couponRepository.lockById(ctx.tx, coupon.id) : null;
    if (cart.couponCode && !locked) throw couponError('not_found');
    if (locked) {
      const check = couponService.check(locked, { customerId: buyer.customerId, now: ctx.now });
      if (!check.ok) throw couponError(check.reason);
    }

    // 下架的商品顧客本來就看不到（購物車顯示時已經濾掉），結帳跟著同一個判斷。
    const lines: { productId: string; quantity: number }[] = [];
    for (const row of await cartRepository.items(ctx.tx, cart.id)) {
      const product = await catalogService.findById(ctx.tx, row.productId);
      if (product?.status === 'active') lines.push({ productId: row.productId, quantity: row.quantity });
    }
    if (lines.length === 0) throw PlatformError.validation('Your cart is empty');

    const order = await createOrderFromLines(deps, {
      lines,
      metadata: input.metadata,
      couponPromotionIds: locked ? [locked.promotionId] : [],
    }, ctx);

    if (locked) await redeemCoupon(ctx, locked, order, buyer.customerId);
    await cartRepository.markCheckedOut(ctx.tx, cart.id, order.id, ctx.now);
    return order;
  };
}

/**
 * 核銷。與訂單在同一個交易內成立——訂單回滾，核銷就不曾發生。
 *
 * 券沒有真的折到錢時不核銷：門檻沒達到的券被吃掉，是顧客最不能接受的那種損失。
 */
async function redeemCoupon(
  ctx: CommandContext,
  coupon: { id: string; code: string; promotionId: string; partnerCode: string | null; customerId: string | null },
  order: OrderDto,
  customerId: string,
): Promise<void> {
  const discountCents = order.adjustments
    .filter((adjustment) => adjustment.sourceId === coupon.promotionId)
    .reduce((sum, adjustment) => sum - adjustment.amountCents, 0);
  if (discountCents <= 0) return;

  await couponRepository.recordRedemption(ctx.tx, {
    couponId: coupon.id,
    promotionId: coupon.promotionId,
    orderId: order.id,
    customerId,
    code: coupon.code,
    partnerCode: coupon.partnerCode,
    discountCents,
    redeemedAt: ctx.now,
  });
  // 實發券用完就沒了；共用碼還留著給下一個人（額度控制是工單 32）。
  if (coupon.customerId) await couponRepository.update(ctx.tx, coupon.id, { status: 'used', updatedAt: ctx.now });
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
    await assertOwnedByActor(ctx, order);
    const lineRows = await repository.linesFor(ctx.tx, order.id);
    const adjustmentRows = await repository.adjustmentsFor(ctx.tx, order.id);

    if (order.status === 'paid' || order.status === 'payment_processing') return toOrderDto(order, lineRows, adjustmentRows);
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be paid (status=${order.status})`);
    }
    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'payment_processing', updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();
    const provider = deps.providers.get<PaymentProvider>('payment', input.provider);
    await ctx.enqueue({ type: PROCESS_PAYMENT_JOB, payload: { orderId: order.id, orderNumber: order.number, amountCents: order.totalCents, currency: order.currency, provider: provider.id }, dedupeKey: `order:pay:${order.id}` });
    return toOrderDto(updated, lineRows, adjustmentRows);
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
    const adjustments = await repository.adjustmentsFor(ctx.tx, order.id);
    if (order.status === 'expired') return toOrderDto(order, lines, adjustments);
    if (order.status === 'paid' || order.status === 'cancelled') return toOrderDto(order, lines, adjustments);
    if (!order.expiresAt || order.expiresAt.getTime() > ctx.now.getTime()) {
      throw PlatformError.conflict(`Order ${order.number} has not reached its payment deadline`);
    }
    for (const line of lines) await inventoryService.release(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
    const [updated] = await ctx.tx.update(orders).set({ status: 'expired', updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    return toOrderDto(updated, lines, adjustments);
  };
}

export function createMarkPaidHandler() {
  return async (input: z.infer<typeof markPaidInput>, ctx: CommandContext): Promise<OrderDto> => {
    if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only a payment worker may confirm payment');
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const lines = await repository.linesFor(ctx.tx, order.id);
    const adjustments = await repository.adjustmentsFor(ctx.tx, order.id);
    if (order.status === 'paid') return toOrderDto(order, lines, adjustments);
    if (order.status !== 'payment_processing') throw PlatformError.conflict(`Order ${order.number} cannot be marked paid (status=${order.status})`);
    // 唯一鍵衝突必須使整筆交易回滾：同一 provider ref 絕不能支付兩張訂單。
    await ctx.tx.insert(orderPayments).values({ id: randomUUID(), orderId: order.id, provider: input.provider, providerRef: input.providerRef, amountCents: order.totalCents, status: 'succeeded', createdAt: ctx.now });
    for (const line of lines) await inventoryService.commitReservation(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
    const [updated] = await ctx.tx.update(orders).set({ status: 'paid', paidAt: ctx.now, updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    const dto = toOrderDto(updated, lines, adjustments);
    await ctx.publish({ name: orderPaidV1.name, payload: { orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, currency: dto.currency, totalCents: dto.totalCents, paidAt: dto.paidAt!, paymentProvider: input.provider, paymentRef: input.providerRef, lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents }) => ({ productId, sku, name, quantity, unitPriceCents, lineTotalCents })) } });
    await ctx.publish({
      name: orderPaidV2.name,
      payload: { orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, customerId: dto.customerId,
        currency: dto.currency, paidAt: dto.paidAt!, paymentProvider: input.provider, paymentRef: input.providerRef,
        subtotalCents: dto.subtotalCents, discountCents: dto.discountCents, shippingCents: dto.shippingCents,
        taxCents: dto.taxCents, totalCents: dto.totalCents, adjustments: dto.adjustments,
        lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents }) => ({
          productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents, netCents: lineTotalCents - discountCents,
        })), },
    });
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
    await assertOwnedByActor(ctx, order);
    const lineRows = await repository.linesFor(ctx.tx, order.id);
    const adjustmentRows = await repository.adjustmentsFor(ctx.tx, order.id);
    if (order.status === 'cancelled') return toOrderDto(order, lineRows, adjustmentRows);
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

    const dto = toOrderDto(updated, lineRows, adjustmentRows);
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
