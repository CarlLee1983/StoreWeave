import { evaluateRule } from './rules';
import type { Adjustment, AppliedPromotion, PricingInput, PricingLineInput, PricingResult, Promotion } from './types';

export function lineTotalCents(line: PricingLineInput): number {
  return line.unitPriceCents * line.quantity;
}

export function subtotalOf(lines: readonly PricingLineInput[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

function isActive(promotion: Promotion, now: Date): boolean {
  if (promotion.startsAt && now.getTime() < promotion.startsAt.getTime()) return false;
  if (promotion.endsAt && now.getTime() >= promotion.endsAt.getTime()) return false;
  return true;
}

/** 優先序相同時以活動 id 決定順序，讓輸出與輸入陣列的排列無關。 */
function inApplicationOrder(promotions: readonly Promotion[]): Promotion[] {
  return [...promotions].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * 定價引擎。輸入購物內容、情境與當下時間，輸出調整明細與總額。
 * 純函式：不碰資料庫、不讀時鐘、不修改輸入。
 */
export function calculatePricing(input: PricingInput): PricingResult {
  const subtotalCents = subtotalOf(input.lines);
  const shippingCents = input.shippingCents ?? 0;
  const taxCents = input.taxCents ?? 0;

  const adjustments: Adjustment[] = [];
  const appliedPromotions: AppliedPromotion[] = [];
  let discountCents = 0;

  for (const promotion of inApplicationOrder(input.context.promotions)) {
    if (!isActive(promotion, input.now)) continue;

    const wanted = evaluateRule({ rule: promotion.rule, lines: input.lines, subtotalCents });
    // 折扣總額不得超過商品小計，否則會出現負數訂單。
    const granted = Math.min(wanted, subtotalCents - discountCents);
    if (granted <= 0) continue;

    discountCents += granted;
    adjustments.push({
      source: 'promotion',
      sourceId: promotion.id,
      name: promotion.name,
      amountCents: -granted,
    });
    appliedPromotions.push({ promotionId: promotion.id, name: promotion.name, discountCents: granted });
  }

  return {
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents - discountCents + shippingCents + taxCents,
    adjustments,
    appliedPromotions,
  };
}
