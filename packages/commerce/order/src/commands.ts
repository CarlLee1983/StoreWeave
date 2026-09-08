import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { PermanentJobError } from '@storeweave/jobs';
import type { PaymentProvider, PaymentStartResult, ProviderRegistry } from '@storeweave/extension-sdk';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import { customerService } from '@storeweave/customer';
import { pricingService } from '@storeweave/promotion';
import { shippingService, type ShippingDestinationInput } from '@storeweave/shipping';
import { cartService, isPurchasable } from '@storeweave/cart';
import { couponService, reverseCouponForOrder } from '@storeweave/coupon';
import { maxRedeemableCents, rewardService, tierService } from '@storeweave/loyalty';
import {
  cancelOrderInput, checkoutCartInput, orderOutputDto, payOrderInput, placeOrderInput,
  recordPaymentResultInput, type OrderDto, type OrderOutputDto,
} from './dto';
import { OrderRepository, toCustomerOrderDto, toOrderDto } from './repository';
import { orderCancelledV1, orderPaidV2, orderPaymentInfoIssuedV1, orderPlacedV3 } from './events';
import { orderAdjustments, orderDeliveries, orderLines, orderPayments, orders } from './schema';

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

/** Keep operational payment evidence on server-side commands, not customer responses. */
function orderOutputForActor(ctx: CommandContext, order: OrderDto): OrderOutputDto {
  return ctx.actor.type === 'customer' ? toCustomerOrderDto(order) : order;
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
  output: orderOutputDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: {
    action: 'order.placed',
    resourceType: 'order',
    resourceId: (_i, o: OrderOutputDto) => o.id,
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
    /** 購物金折抵。上限由呼叫端算好，引擎只負責套用與分攤。 */
    rewardRedeemCents?: number;
    /** Checkout passes a concrete merchant method and destination; direct back-office orders may omit delivery. */
    delivery?: { shippingMethodId: string; destination: ShippingDestinationInput };
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

  // 配送費是商家的交易政策：在優惠引擎算總額以前，先把目前可用的方法解成不可變快照。
  // 之後停用、改名或改價都不會改寫這張訂單。
  const deliverySnapshot = input.delivery
    ? await shippingService.resolveCheckoutMethod(ctx.tx, {
      shippingMethodId: input.delivery.shippingMethodId,
      subtotalCents: lines.reduce((total, line) => total + line.lineTotalCents, 0),
      destinationKind: input.delivery.destination.kind,
    })
    : null;

  // 定價與訂單建立在同一個交易內：折扣依據的活動狀態與寫進訂單的金額必定一致。
  // 等級限定的活動要看得到下單者的等級。與購物車的試算讀的是同一支。
  const membershipTier = (await tierService.currentTierFor(ctx.tx, buyer.customerId)).name;

  const pricing = await pricingService.quote(ctx.tx, {
    couponPromotionIds: input.couponPromotionIds,
    rewardRedeemCents: input.rewardRedeemCents,
    membershipTier,
    shippingCents: deliverySnapshot?.shippingCents,
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
    shippingCents: pricing.shippingCents,
    taxCents: pricing.taxCents,
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

  let deliveryRow: typeof orderDeliveries.$inferSelect | null = null;
  if (deliverySnapshot && input.delivery) {
    const destination = input.delivery.destination;
    const [inserted] = await ctx.tx.insert(orderDeliveries).values({
      orderId,
      shippingMethodId: deliverySnapshot.id,
      shippingMethodCode: deliverySnapshot.code,
      shippingMethodName: deliverySnapshot.name,
      provider: deliverySnapshot.provider,
      type: deliverySnapshot.type,
      destinationKind: deliverySnapshot.destinationKind,
      recipient: destination.recipient,
      phone: destination.phone,
      ...(destination.kind === 'taiwan_home'
        ? {
          countryCode: destination.countryCode, postcode: destination.postcode, city: destination.city,
          district: destination.district, line1: destination.line1, line2: destination.line2,
          providerStoreId: null, storeName: null, storeAddress: null,
        }
        : {
          countryCode: null, postcode: null, city: null, district: null, line1: null, line2: null,
          providerStoreId: destination.providerStoreId, storeName: destination.storeName, storeAddress: destination.storeAddress,
        }),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }).returning();
    deliveryRow = inserted;
  }

  const dto = toOrderDto(orderRow, lineRows, adjustmentRows, [], deliveryRow);
  await ctx.enqueue({
    type: EXPIRE_ORDER_JOB,
    payload: { orderId, expiresAt: expiresAt.toISOString() },
    dedupeKey: `order:expire:${orderId}`,
    runAt: expiresAt,
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
  return async (input: z.infer<typeof placeOrderInput>, ctx: CommandContext): Promise<OrderOutputDto> =>
    orderOutputForActor(ctx, await createOrderFromLines(deps, input, ctx));
}

export const checkoutCartCommand = defineCommand({
  name: 'commerce.order.checkoutCart',
  summary: '把購物車轉成訂單',
  input: checkoutCartInput,
  output: orderOutputDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: {
    action: 'order.placed',
    resourceType: 'order',
    resourceId: (_i, o: OrderOutputDto) => o.id,
    redact: () => ({}),
  },
});

/**
 * 購物車結帳。冪等的來源是購物車本身：先鎖住那一列，已經結過就回同一張訂單。
 * 呼叫端帶什麼冪等鍵都不影響這個保證——重複送出的表單本來就不會帶對 key，
 * 而每次現產一個隨機值等於沒有保護（Spec 0003 要修的就是這個缺陷）。
 */
export function createCheckoutCartHandler(deps: OrderModuleDeps) {
  return async (input: z.infer<typeof checkoutCartInput>, ctx: CommandContext): Promise<OrderOutputDto> => {
    const buyer = await customerService.requireByActor(ctx.tx, ctx.actor);
    const cart = await cartService.lockForCheckout(ctx.tx, input.cartId);
    // 別人的車、或還沒併進來的訪客車，都不是這個人結得了的。
    if (!cart || cart.customerId !== buyer.customerId) throw PlatformError.notFound('Cart', input.cartId);

    if (cart.orderId) {
      const existing = await repository.findById(ctx.tx, cart.orderId);
      if (existing) {
        return orderOutputForActor(ctx, toOrderDto(
          existing,
          await repository.linesFor(ctx.tx, existing.id),
          await repository.adjustmentsFor(ctx.tx, existing.id),
          await repository.paymentsFor(ctx.tx, existing.id),
          await repository.deliveryFor(ctx.tx, existing.id),
        ));
      }
    }
    if (cart.status !== 'open') throw PlatformError.conflict(`Cart ${cart.id} is no longer open`);

    // 券在這裡鎖住並重驗：試算到結帳之間它可能過期或被停用，
    // 而顧客看到的金額必須是實際會扣的金額。
    const locked = cart.couponCode
      ? await couponService.lockEligibleForCheckout(ctx.tx, { code: cart.couponCode, customerId: buyer.customerId, now: ctx.now })
      : null;

    // 顧客看不到的商品行也結不進訂單：判斷與購物車顯示共用 `isPurchasable`，
    // 兩邊各寫一次，遲早會有一邊多放行一種情況（例如幣別不符的商品）。
    const lines: { productId: string; quantity: number }[] = [];
    for (const row of await cartService.checkoutItems(ctx.tx, cart.id)) {
      const product = await catalogService.findById(ctx.tx, row.productId);
      if (isPurchasable(product, deps.defaultCurrency)) {
        lines.push({ productId: row.productId, quantity: row.quantity });
      }
    }
    if (lines.length === 0) throw PlatformError.validation('Your cart is empty');
    // 上限與 placeOrder 共用同一份宣告：從購物車進來的路徑本來完全繞過那個 schema，
    // 於是一張訂單可以帶數千行進 createOrderFromLines，在同一交易內鎖住大量庫存列。
    const bounded = placeOrderInput.shape.lines.safeParse(lines);
    if (!bounded.success) {
      throw PlatformError.validation('Your cart has too many items to check out', bounded.error.issues);
    }

    // 折抵上限在結帳當下重新算：購物車存的是「顧客希望折多少」，
    // 而餘額與小計在那之後都可能變過。先鎖住這位顧客的購物金，
    // 讀餘額與寫負分錄之間才不會有別人插進來。
    await rewardService.lockCustomer(ctx.tx, buyer.customerId);
    const subtotalCents = await subtotalOfLines(ctx, lines);
    const balance = await rewardService.balanceFor(ctx.tx, buyer.customerId, ctx.now, ctx.logger);
    const rewardRedeemCents = Math.min(
      cart.rewardRedeemCents,
      maxRedeemableCents(balance.availableCents, subtotalCents),
    );

    const destination = input.pickupSelectionToken
      ? await shippingService.consumePickupSelection(ctx.tx, {
        token: input.pickupSelectionToken, cartId: cart.id, customerId: buyer.customerId, shippingMethodId: input.shippingMethodId,
        recipient: input.pickupRecipient!, phone: input.pickupPhone!,
      }, ctx.now)
      : input.destination!;

    const order = await createOrderFromLines(deps, {
      lines: bounded.data,
      // `metadata` is caller extensible, but invoice preference is a reserved,
      // typed checkout fact. Overwrite any caller-supplied shadow value rather
      // than letting an unvalidated JSON shape reach the invoice worker.
      metadata: { ...input.metadata, invoicePreference: input.invoicePreference ?? { kind: 'ecpay' } },
      couponPromotionIds: locked ? [locked.promotionId] : [],
      rewardRedeemCents,
      delivery: { shippingMethodId: input.shippingMethodId, destination },
    }, ctx);

    // 折抵與訂單在同一個交易內成立：訂單回滾了，購物金就沒有被扣過。
    const redeemed = order.adjustments
      .filter((adjustment) => adjustment.source === 'reward')
      .reduce((sum, adjustment) => sum - adjustment.amountCents, 0);
    if (redeemed > 0) {
      await rewardService.redeemForOrder(ctx.tx, {
        customerId: buyer.customerId,
        orderId: order.id,
        amountCents: redeemed,
        now: ctx.now,
      });
    }

    if (locked) await redeemCoupon(ctx, locked, order, buyer.customerId);
    await cartService.markCheckedOut(ctx.tx, cart.id, order.id, ctx.now);
    return orderOutputForActor(ctx, order);
  };
}

/**
 * 核銷。與訂單在同一個交易內成立——訂單回滾，核銷就不曾發生。
 *
 * 券沒有真的折到錢時不核銷：門檻沒達到的券被吃掉，是顧客最不能接受的那種損失。
 */
async function redeemCoupon(
  ctx: CommandContext,
  coupon: { id: string; promotionId: string },
  order: OrderDto,
  customerId: string,
): Promise<void> {
  const discountCents = order.adjustments
    .filter((adjustment) => adjustment.sourceId === coupon.promotionId)
    .reduce((sum, adjustment) => sum - adjustment.amountCents, 0);
  if (discountCents <= 0) return;

  await couponService.redeemForOrder(ctx.tx, {
    couponId: coupon.id, orderId: order.id, customerId,
    discountCents, orderTotalCents: order.totalCents, now: ctx.now,
  });
}

/** 折抵上限看的是商品小計，因此要先知道這些行加起來多少。 */
async function subtotalOfLines(
  ctx: CommandContext,
  lines: readonly { productId: string; quantity: number }[],
): Promise<number> {
  let subtotal = 0;
  for (const line of lines) {
    const product = await catalogService.requireActiveProduct(ctx.tx, line.productId);
    subtotal += product.priceCents * line.quantity;
  }
  return subtotal;
}

export const payOrderCommand = defineCommand({
  name: 'commerce.order.payOrder',
  summary: '建立付款嘗試並要求背景工作啟動 payment provider',
  input: payOrderInput,
  output: orderOutputDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: { action: 'order.paid', resourceType: 'order', resourceId: (i) => i.orderId },
});

export function createPayOrderHandler(deps: OrderModuleDeps) {
  return async (input: z.infer<typeof payOrderInput>, ctx: CommandContext): Promise<OrderOutputDto> => {
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    await assertOwnedByActor(ctx, order);
    const [lineRows, adjustmentRows, paymentRows, delivery] = await Promise.all([
      repository.linesFor(ctx.tx, order.id),
      repository.adjustmentsFor(ctx.tx, order.id),
      repository.paymentsFor(ctx.tx, order.id),
      repository.deliveryFor(ctx.tx, order.id),
    ]);

    // 已送往金流或正在等待繳款時，不建立第二筆 attempt。真正失敗會由
    // recordPaymentResult 把 Order 放回 pending，屆時才能由顧客重新選方式。
    if (order.status === 'paid' || order.status === 'payment_processing' || order.status === 'awaiting_payment') {
      return orderOutputForActor(ctx, toOrderDto(order, lineRows, adjustmentRows, paymentRows, delivery));
    }
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be paid (status=${order.status})`);
    }

    // 0 元訂單絕不能送到外部金流（綠界的 TotalAmount 也不接受它）。仍留下
    // 一筆 internal attempt，讓稽核與付款成功路徑只有一份實作。
    if (order.totalCents === 0) {
      const attemptRef = `internal:${randomUUID()}`;
      const [attempt] = await ctx.tx.insert(orderPayments).values({
        id: randomUUID(), orderId: order.id, attemptRef, provider: 'internal', method: 'internal',
        providerRef: `internal:${order.id}`, amountCents: 0, status: 'created',
        createdAt: ctx.now, updatedAt: ctx.now,
      }).returning();
      const [processing] = await ctx.tx.update(orders)
        .set({ status: 'payment_processing', updatedAt: ctx.now })
        .where(eq(orders.id, order.id))
        .returning();
      return orderOutputForActor(ctx, await markOrderPaid(ctx, processing, attempt, { provider: 'internal', providerRef: attempt.providerRef! }));
    }

    const provider = deps.providers.get<PaymentProvider>('payment', input.provider);
    const method = resolvePaymentMethod(provider, input.method);
    const attemptRef = `payment:${randomUUID()}`;
    const [attempt] = await ctx.tx.insert(orderPayments).values({
      id: randomUUID(), orderId: order.id, attemptRef, provider: provider.id, method,
      providerRef: null, amountCents: order.totalCents, status: 'created',
      createdAt: ctx.now, updatedAt: ctx.now,
    }).returning();
    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'payment_processing', updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();
    await ctx.enqueue({
      type: PROCESS_PAYMENT_JOB,
      payload: {
        orderId: order.id, orderNumber: order.number, amountCents: order.totalCents,
        currency: order.currency, provider: provider.id, method, attemptRef,
      },
      // 一次付款嘗試一把 dedupe key；失敗後的新 attempt 不能被已完成的 job 擋住。
      dedupeKey: `order:pay:${attemptRef}`,
    });
    return orderOutputForActor(ctx, toOrderDto(updated, lineRows, adjustmentRows, [...paymentRows, attempt], delivery));
  };
}

function resolvePaymentMethod(provider: PaymentProvider, requested: string | undefined): string {
  const methods = provider.paymentMethods();
  // 單一方式沒有選擇歧義，可由店家設定直接選定；多方式一律要求結帳頁明示。
  const method = requested ?? (methods.length === 1 ? methods[0].code : undefined);
  if (!method) throw PlatformError.validation(`Choose a payment method for provider ${provider.id}`);
  if (!methods.some((candidate) => candidate.code === method)) {
    throw PlatformError.validation(`Payment method ${method} is not enabled for provider ${provider.id}`);
  }
  return method;
}

/** Worker 與 callback controller 都透過這支 command 保存 provider 的標準化結果。 */
export const recordPaymentResultCommand = defineCommand({
  name: 'commerce.order.recordPaymentResult',
  summary: '保存付款嘗試結果並推導訂單付款狀態',
  input: recordPaymentResultInput,
  output: orderOutputDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: {
    action: 'order.payment_result',
    resourceType: 'order',
    resourceId: (_input, output: OrderOutputDto) => output.id,
    redact: (input) => ({ provider: input.provider, status: input.status, attemptRef: input.attemptRef }),
  },
});

export const expireOrderCommand = defineCommand({
  name: 'commerce.order.expireOrder', summary: '釋放逾時未付款訂單的庫存預留',
  input: z.object({ orderId: z.string().uuid() }).strict(), output: orderOutputDto, permission: 'order:write', idempotency: 'required',
  audit: { action: 'order.expired', resourceType: 'order', resourceId: (i) => i.orderId },
});

export function createExpireOrderHandler() {
  return async (input: { orderId: string }, ctx: CommandContext): Promise<OrderDto> => {
    if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only the worker may expire an order');
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    const [lines, adjustments, payments, delivery] = await Promise.all([
      repository.linesFor(ctx.tx, order.id),
      repository.adjustmentsFor(ctx.tx, order.id),
      repository.paymentsFor(ctx.tx, order.id),
      repository.deliveryFor(ctx.tx, order.id),
    ]);
    if (order.status === 'expired') return toOrderDto(order, lines, adjustments, payments, delivery);
    if (order.status === 'paid' || order.status === 'cancelled') return toOrderDto(order, lines, adjustments, payments, delivery);
    // 排程被延後（例如 ATM 取號）時，已被舊 worker 認領的工作仍可能先跑到。
    // 它不是失敗，不應進 DLQ；新的到期工作會以新的 occurrence key 留在佇列裡。
    if (!order.expiresAt || order.expiresAt.getTime() > ctx.now.getTime()) {
      return toOrderDto(order, lines, adjustments, payments, delivery);
    }
    for (const line of lines) await inventoryService.release(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
    // 逾時與取消對顧客是同一件事：那張單沒有成立，折抵掉的購物金與用掉的券都要還他。
    await reverseCouponForOrder(ctx.tx, { orderId: order.id, now: ctx.now });
    if (order.customerId) {
      await rewardService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
      await tierService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
    }
    await ctx.tx.update(orderPayments)
      .set({ status: 'expired', updatedAt: ctx.now })
      .where(and(
        eq(orderPayments.orderId, order.id),
        inArray(orderPayments.status, ['created', 'submitted', 'awaiting_payment']),
      ));
    const [updated] = await ctx.tx.update(orders).set({ status: 'expired', updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    return toOrderDto(updated, lines, adjustments, await repository.paymentsFor(ctx.tx, order.id), delivery);
  };
}

/**
 * The only transition that commits inventory and grants customer value. Keeping it
 * shared means synchronous, redirected and callback-confirmed payments cannot drift.
 */
async function markOrderPaid(
  ctx: CommandContext,
  order: typeof orders.$inferSelect,
  attempt: typeof orderPayments.$inferSelect,
  input: { provider: string; providerRef: string },
): Promise<OrderDto> {
  const [lines, adjustments, delivery] = await Promise.all([
    repository.linesFor(ctx.tx, order.id),
    repository.adjustmentsFor(ctx.tx, order.id),
    repository.deliveryFor(ctx.tx, order.id),
  ]);
  if (order.status === 'paid') return toOrderDto(order, lines, adjustments, await repository.paymentsFor(ctx.tx, order.id), delivery);
  if (order.status !== 'payment_processing' && order.status !== 'awaiting_payment') {
    throw PlatformError.conflict(`Order ${order.number} cannot be marked paid (status=${order.status})`);
  }
  if (attempt.orderId !== order.id) throw PlatformError.validation('Payment attempt does not belong to this order');
  if (attempt.provider !== input.provider) throw PlatformError.validation('Payment provider does not match the attempt');
  if (attempt.status === 'expired') throw PlatformError.conflict(`Payment attempt ${attempt.attemptRef} has expired`);
  if (attempt.status === 'succeeded' && attempt.providerRef !== input.providerRef) {
    throw PlatformError.conflict(`Payment attempt ${attempt.attemptRef} was confirmed with a different provider reference`);
  }

  // A gateway can use one reference for checkout and another for its final charge;
  // the provider verifies that correspondence before this command is ever invoked.
  await repository.updatePayment(ctx.tx, attempt.id, {
    providerRef: input.providerRef,
    status: 'succeeded',
    failureMessage: null,
  }, ctx.now);
  for (const line of lines) await inventoryService.commitReservation(ctx, { productId: line.productId, quantity: line.quantity, reference: order.number });
  const [updated] = await ctx.tx.update(orders)
    .set({ status: 'paid', paidAt: ctx.now, updatedAt: ctx.now })
    .where(eq(orders.id, order.id))
    .returning();

  // 購物金在付款完成時入帳，與付款同一個交易——付款回滾了，購物金就不曾發生。
  // 生效日往後推，因此取消回沖只是扣掉一筆還沒生效的分錄（Spec 0005）。
  if (order.customerId) {
    const multiplier = await tierService.multiplierFor(ctx.tx, order.customerId);
    await rewardService.accrueForOrder(ctx.tx, {
      customerId: order.customerId, orderId: order.id, netCents: order.totalCents, now: ctx.now, multiplier,
    });
    await tierService.accrueForOrder(ctx.tx, {
      customerId: order.customerId, orderId: order.id, netCents: order.totalCents, now: ctx.now,
    });
  }

  const dto = toOrderDto(updated, lines, adjustments, await repository.paymentsFor(ctx.tx, order.id), delivery);
  await ctx.publish({
    name: orderPaidV2.name,
    payload: {
      orderId: dto.id, orderNumber: dto.number, customerEmail: dto.customerEmail, customerId: dto.customerId,
      currency: dto.currency, paidAt: dto.paidAt!, paymentProvider: input.provider, paymentRef: input.providerRef,
      subtotalCents: dto.subtotalCents, discountCents: dto.discountCents, shippingCents: dto.shippingCents,
      taxCents: dto.taxCents, totalCents: dto.totalCents, adjustments: dto.adjustments,
      lines: dto.lines.map(({ productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents }) => ({
        productId, sku, name, quantity, unitPriceCents, lineTotalCents, discountCents, netCents: lineTotalCents - discountCents,
      })),
    },
  });
  return dto;
}

export function createRecordPaymentResultHandler() {
  return async (input: z.infer<typeof recordPaymentResultInput>, ctx: CommandContext): Promise<OrderDto> => {
    if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only a payment worker or callback may record payment results');
    const found = await repository.findPaymentByAttemptRef(ctx.tx, input.attemptRef);
    if (!found) throw PlatformError.notFound('Payment attempt', input.attemptRef);
    // Lock aggregate before attempt, matching pay / expire lock order.
    const order = await repository.lockById(ctx.tx, found.orderId);
    if (!order) throw PlatformError.notFound('Order', found.orderId);
    const attempt = await repository.lockPaymentByAttemptRef(ctx.tx, input.attemptRef);
    if (!attempt) throw PlatformError.notFound('Payment attempt', input.attemptRef);
    if (attempt.provider !== input.provider) throw PlatformError.validation('Payment provider does not match the attempt');

    if (order.status === 'paid' || order.status === 'expired' || order.status === 'cancelled') {
      // A trusted provider can be late, but it must never revive an order after
      // expiry won the row lock. The attempt remains operational evidence for reconciliation.
      if (order.status !== 'paid') ctx.logger.warn({ orderId: order.id, attemptRef: attempt.attemptRef }, 'ignored payment result for terminal order');
      return orderDtoWithDetails(ctx, order);
    }

    switch (input.status) {
      case 'confirmed': {
        if (attempt.status === 'succeeded') {
          if (attempt.providerRef !== input.providerRef) {
            throw PlatformError.conflict(`Payment attempt ${attempt.attemptRef} was confirmed with a different provider reference`);
          }
          return orderDtoWithDetails(ctx, order);
        }
        if (attempt.status === 'failed' || attempt.status === 'expired') return orderDtoWithDetails(ctx, order);
        return markOrderPaid(ctx, order, attempt, input);
      }

      case 'redirect': {
        // A duplicated worker run after a callback must not replace instructions
        // or downgrade an already confirmed attempt back to submitted.
        if (order.status !== 'payment_processing' || !['created', 'submitted'].includes(attempt.status)) {
          return orderDtoWithDetails(ctx, order);
        }
        await repository.updatePayment(ctx.tx, attempt.id, {
          status: 'submitted', providerRef: input.providerRef, action: input.action,
          failureMessage: null,
        }, ctx.now);
        return orderDtoWithDetails(ctx, order);
      }

      case 'awaiting_payment': {
        if (input.expiresAt.getTime() <= ctx.now.getTime()) {
          throw PlatformError.validation('Payment instructions have already expired');
        }
        if (!['payment_processing', 'awaiting_payment'].includes(order.status)
          || ['succeeded', 'failed', 'expired'].includes(attempt.status)) {
          return orderDtoWithDetails(ctx, order);
        }
        const alreadyRecorded = attempt.status === 'awaiting_payment'
          && attempt.providerRef === input.providerRef
          && attempt.expiresAt?.getTime() === input.expiresAt.getTime()
          && JSON.stringify(attempt.instructions) === JSON.stringify(input.instructions);
        await repository.updatePayment(ctx.tx, attempt.id, {
          status: 'awaiting_payment', providerRef: input.providerRef,
          instructions: [...input.instructions], expiresAt: input.expiresAt, failureMessage: null,
        }, ctx.now);
        const [updated] = await ctx.tx.update(orders)
          .set({ status: 'awaiting_payment', expiresAt: input.expiresAt, updatedAt: ctx.now })
          .where(eq(orders.id, order.id))
          .returning();
        await ctx.enqueue({
          type: EXPIRE_ORDER_JOB,
          payload: { orderId: order.id, expiresAt: input.expiresAt.toISOString() },
          dedupeKey: `order:expire:${order.id}`,
          runAt: input.expiresAt,
          replaceExisting: true,
        });
        const dto = await orderDtoWithDetails(ctx, updated);
        if (!alreadyRecorded) {
          await ctx.publish({
            name: orderPaymentInfoIssuedV1.name,
            payload: {
              orderId: dto.id, orderNumber: dto.number, paymentAttemptRef: attempt.attemptRef,
              paymentProvider: input.provider, instructions: [...input.instructions], expiresAt: input.expiresAt,
            },
          });
        }
        return dto;
      }

      case 'failed': {
        // A retry has already received a new attemptRef. Replaying the old
        // failure must not downgrade the newer active attempt back to pending.
        if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'expired') {
          return orderDtoWithDetails(ctx, order);
        }
        await repository.updatePayment(ctx.tx, attempt.id, {
          status: 'failed', providerRef: input.providerRef ?? attempt.providerRef,
          failureMessage: input.message ?? 'Payment provider rejected this attempt',
        }, ctx.now);
        const updated = order.status === 'payment_processing' || order.status === 'awaiting_payment'
          ? (await ctx.tx.update(orders).set({ status: 'pending', updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning())[0]
          : order;
        return orderDtoWithDetails(ctx, updated);
      }
    }
  };
}

async function orderDtoWithDetails(ctx: CommandContext, order: typeof orders.$inferSelect): Promise<OrderDto> {
  const [lines, adjustments, payments, delivery] = await Promise.all([
    repository.linesFor(ctx.tx, order.id),
    repository.adjustmentsFor(ctx.tx, order.id),
    repository.paymentsFor(ctx.tx, order.id),
    repository.deliveryFor(ctx.tx, order.id),
  ]);
  return toOrderDto(order, lines, adjustments, payments, delivery);
}

type CoreJobContext = {
  executeCommand(name: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  executeQuery(name: string, input: unknown): Promise<any>;
};

export function createProcessPaymentJob(deps: OrderModuleDeps) {
  return async (raw: unknown, rawCtx: unknown): Promise<void> => {
    const { orderId, orderNumber, amountCents, currency, provider: providerId, method, attemptRef } = z.object({
      orderId: z.string().uuid(), orderNumber: z.string(), amountCents: z.number().int().nonnegative(),
      currency: z.string(), provider: z.string(), method: z.string(), attemptRef: z.string(),
    }).strict().parse(raw);
    const ctx = rawCtx as CoreJobContext;
    const current = await ctx.executeQuery('commerce.order.getOrder', { id: orderId });
    const attempt = current.paymentAttempts.find((candidate: { attemptRef: string }) => candidate.attemptRef === attemptRef);
    if (!attempt) throw new PermanentJobError(`Payment attempt ${attemptRef} does not exist on order ${orderId}`);
    if (current.status !== 'payment_processing' || !['created', 'submitted'].includes(attempt.status)) return;
    if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
      await ctx.executeCommand('commerce.order.expireOrder', { orderId }, `expire-order:${orderId}:${new Date(current.expiresAt).getTime()}`);
      return;
    }
    const provider = deps.providers.get<PaymentProvider>('payment', providerId);
    // Job 在交易外呼叫 provider；同一 attemptRef 重試時 provider 會回放同一筆外部交易。
    const result = await provider.start({ orderId, orderNumber, amountCents, currency, method, reference: attemptRef });
    const input = paymentResultFromStart(provider.id, attemptRef, result);
    const providerRef = 'providerRef' in input && input.providerRef ? input.providerRef : 'none';
    await ctx.executeCommand(
      'commerce.order.recordPaymentResult',
      input,
      `payment-result:${provider.id}:${attemptRef}:${input.status}:${providerRef}`,
    );
  };
}

function paymentResultFromStart(provider: string, attemptRef: string, result: PaymentStartResult): z.input<typeof recordPaymentResultInput> {
  switch (result.status) {
    case 'confirmed':
      return { attemptRef, provider, status: 'confirmed', providerRef: result.providerRef };
    case 'redirect':
      return { attemptRef, provider, status: 'redirect', providerRef: result.providerRef, action: result.action };
    case 'awaiting_payment':
      return {
        attemptRef, provider, status: 'awaiting_payment', providerRef: result.providerRef,
        instructions: [...result.instructions], expiresAt: new Date(result.expiresAt),
      };
    case 'failed':
      return {
        attemptRef, provider, status: 'failed',
        ...(result.providerRef ? { providerRef: result.providerRef } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
  }
}

export function createExpireReservationJob() {
  return async (raw: unknown, rawCtx: unknown): Promise<void> => {
    const { orderId, expiresAt } = z.object({ orderId: z.string().uuid(), expiresAt: z.string().datetime().optional() }).strict().parse(raw);
    const ctx = rawCtx as CoreJobContext;
    // The occurrence key changes when a deferred payment supplies a later deadline.
    // An old, already-claimed job can therefore no-op without poisoning the real expiry.
    await ctx.executeCommand('commerce.order.expireOrder', { orderId }, `expire-order:${orderId}:${expiresAt ?? 'legacy'}`);
  };
}

export const cancelOrderCommand = defineCommand({
  name: 'commerce.order.cancelOrder',
  summary: '取消訂單並回補庫存',
  input: cancelOrderInput,
  output: orderOutputDto,
  permission: 'order:write',
  idempotency: 'required',
  audit: { action: 'order.cancelled', resourceType: 'order', resourceId: (i) => i.orderId, redact: (i) => ({ reason: i.reason }) },
});

export function createCancelOrderHandler(_deps: OrderModuleDeps) {
  return async (input: z.infer<typeof cancelOrderInput>, ctx: CommandContext): Promise<OrderOutputDto> => {
    const order = await repository.lockById(ctx.tx, input.orderId);
    if (!order) throw PlatformError.notFound('Order', input.orderId);
    await assertOwnedByActor(ctx, order);
    const [lineRows, adjustmentRows, paymentRows, delivery] = await Promise.all([
      repository.linesFor(ctx.tx, order.id),
      repository.adjustmentsFor(ctx.tx, order.id),
      repository.paymentsFor(ctx.tx, order.id),
      repository.deliveryFor(ctx.tx, order.id),
    ]);
    if (order.status === 'cancelled') {
      return orderOutputForActor(ctx, toOrderDto(order, lineRows, adjustmentRows, paymentRows, delivery));
    }
    if (order.status !== 'pending') {
      throw PlatformError.conflict(`Order ${order.number} cannot be cancelled (status=${order.status})`);
    }
    // Cancellation and shipment creation both lock Order before this check.
    // Any shipment means fulfilment has begun and needs its own reversal flow;
    // this unpaid-order command must not manufacture a cancelled+shipment pair.
    if (await shippingService.hasShipmentForOrder(ctx.tx, order.id)) {
      throw PlatformError.conflict(`Order ${order.number} cannot be cancelled after fulfilment has begun`);
    }

    for (const line of lineRows) {
      await inventoryService.release(ctx, {
        productId: line.productId,
        quantity: line.quantity,
        reference: order.number,
      });
    }

    // 券回沖與取消在同一個交易內：取消失敗，券就沒有被還回去過。
    const reversed = await reverseCouponForOrder(ctx.tx, { orderId: order.id, now: ctx.now });
    // 購物金與等級積分一併回沖：折抵掉的還回去、那張單累積的扣回來，
    // 兩者都是新的反向分錄。與逾時那條路做的事必須完全一樣——不對齊的話，
    // 部分退貨進模型時就會有一條路徑忘了扣回積分。
    if (order.customerId) {
      await rewardService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
      await tierService.reverseForOrder(ctx.tx, { customerId: order.customerId, orderId: order.id, now: ctx.now });
    }
    if (reversed) ctx.logger.info({ orderId: order.id, couponId: reversed.couponId }, 'reversed coupon redemption');

    const [updated] = await ctx.tx.update(orders)
      .set({ status: 'cancelled', cancelledAt: ctx.now, updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();

    const dto = toOrderDto(updated, lineRows, adjustmentRows, paymentRows, delivery);
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
    return orderOutputForActor(ctx, dto);
  };
}
