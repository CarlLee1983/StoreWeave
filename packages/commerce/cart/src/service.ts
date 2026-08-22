import type { DrizzleDb, Logger, Tx } from '@storeweave/contracts';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import { pricingService } from '@storeweave/promotion';
import { couponService } from '@storeweave/coupon';
import { maxRedeemableCents, rewardService, tierService } from '@storeweave/loyalty';
import type { CartDto } from './dto';
import { CartRepository } from './repository';
import type { CartRow } from './schema';

const repository = new CartRepository();

/** 沒有內容時的試算結果。空車不必進定價引擎，答案恆定。 */
export function emptyCartDto(id: string, currency: string): CartDto {
  return {
    id, currency, items: [], subtotalCents: 0, discountCents: 0, totalCents: 0,
    adjustments: [], coupon: null, couponError: null, reward: null, nextThreshold: null,
  };
}

/**
 * 把購物車讀成 DTO。價格、可售量與折扣都是**當下**算出來的：購物車不凍結價格，
 * 顧客看到的永遠是現在的金額，結帳時才不會突然變動。
 *
 * 折扣走的是 `pricingService.quote`——與 `placeOrder` 同一支、同一份活動載入。
 * 這裡刻意不重寫一套定價：兩個入口算出不同金額就是客訴。
 */
export async function toCartDto(
  db: DrizzleDb | Tx,
  cart: CartRow,
  defaultCurrency: string,
  now: Date,
  logger?: Logger,
): Promise<CartDto> {
  const rows = await repository.items(db, cart.id);
  const items = [];

  for (const row of rows) {
    const product = await catalogService.findById(db, row.productId);
    // 下架或刪除的商品不在購物車裡顯示；合併與結帳各自處理它們（工單 27、28）。
    if (!product || product.status !== 'active') continue;
    // 幣別不同的商品進不了同一張訂單，因此也不該混進同一次試算。
    if (product.currency !== defaultCurrency) continue;

    const available = await inventoryService.availableFor(db, row.productId).catch(() => null);
    items.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: row.quantity,
      lineTotalCents: product.priceCents * row.quantity,
      available,
    });
  }

  if (items.length === 0) return emptyCartDto(cart.id, defaultCurrency);

  // 券只是「多帶一條活動進定價」。它在這裡**不**扣任何額度——
  // 限量的扣減只發生在結帳，因此試算成功不保證結帳成功（Spec 0004）。
  const resolved = cart.couponCode
    ? await couponService.resolve(db, { code: cart.couponCode, customerId: cart.customerId, now })
    : null;
  const couponPromotionIds = resolved?.ok ? [resolved.coupon.promotionId] : [];

  // 購物金折抵的上限在這裡重新算：餘額與小計都會變，存下來的只是「顧客希望折多少」。
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const balance = cart.customerId ? await rewardService.balanceFor(db, cart.customerId, now) : null;
  const maxCents = balance ? maxRedeemableCents(balance.availableCents, subtotalCents) : 0;
  const rewardRedeemCents = Math.min(cart.rewardRedeemCents, maxCents);

  // lineId 用 productId：一台車裡一件商品只有一行，這個對應是唯一的。
  // 等級只是定價引擎的一個輸入變數，不是另一套折扣路徑（Spec 0005）。
  const membershipTier = cart.customerId ? (await tierService.currentTierFor(db, cart.customerId)).name : null;

  const pricing = await pricingService.quote(db, {
    couponPromotionIds,
    rewardRedeemCents,
    membershipTier,
    lines: items.map((item) => ({
      lineId: item.productId,
      productId: item.productId,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
    now,
    logger,
  });
  const priced = new Map(pricing.lines.map((line) => [line.lineId, line]));

  return {
    id: cart.id,
    currency: defaultCurrency,
    items: items.map((item) => ({
      ...item,
      discountCents: priced.get(item.productId)!.discountCents,
      netCents: priced.get(item.productId)!.netCents,
    })),
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    totalCents: pricing.totalCents,
    adjustments: pricing.adjustments,
    coupon: resolved?.ok
      ? {
        code: resolved.coupon.code,
        promotionId: resolved.coupon.promotionId,
        discountCents: pricing.appliedPromotions
          .filter((applied) => applied.promotionId === resolved.coupon.promotionId)
          .reduce((sum, applied) => sum + applied.discountCents, 0),
      }
      : null,
    couponError: resolved && !resolved.ok ? resolved.message : null,
    reward: balance
      ? {
        requestedCents: cart.rewardRedeemCents,
        appliedCents: pricing.rewardRedeemedCents,
        availableCents: balance.availableCents,
        maxCents,
      }
      : null,
    nextThreshold: pricing.nextThreshold,
  };
}
