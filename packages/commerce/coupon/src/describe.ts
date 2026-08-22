import type { PromotionDto } from '@storeweave/promotion';

/**
 * 一條規則對顧客的說法。前台要說得出面額——「你有一張券」而不說折什麼，
 * 等於沒有告訴他任何事。
 *
 * 金額的呈現交給前台（幣別與地區格式在那裡），這裡只給結構化的中文描述。
 */
export function describeRule(rule: PromotionDto['rule'], formatMoney: (cents: number) => string): string {
  switch (rule.type) {
    case 'threshold_fixed_amount':
      return `滿 ${formatMoney(rule.thresholdCents)} 折 ${formatMoney(rule.discountCents)}`;
    case 'threshold_percentage':
      return `滿 ${formatMoney(rule.thresholdCents)} 折 ${percentText(rule.percentOffBasisPoints)}`
        + capText(rule.maxDiscountCents, formatMoney);
    case 'order_percentage':
      return `全單折 ${percentText(rule.percentOffBasisPoints)}` + capText(rule.maxDiscountCents, formatMoney);
  }
}

/** 1_000 基點 = 10%。小數點後多餘的零不留。 */
function percentText(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

function capText(maxDiscountCents: number | null | undefined, formatMoney: (cents: number) => string): string {
  return maxDiscountCents === null || maxDiscountCents === undefined ? '' : `（上限 ${formatMoney(maxDiscountCents)}）`;
}
