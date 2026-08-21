import type { PricingLineInput, PromotionRule } from './types';

export interface RuleInput {
  rule: PromotionRule;
  lines: readonly PricingLineInput[];
  /** 商品小計。門檻一律以它判斷，不含運費與稅，也不受先前的折扣影響。 */
  subtotalCents: number;
  /** 尚未被折抵的餘額。百分比折扣算在它上面，所以套用順序會改變結果。 */
  remainingCents: number;
}

/**
 * 一條規則算出來的折扣（正數）。回傳 0 表示條件不成立。
 * 上限與餘數處理由引擎負責，規則只回答「這一條想折多少」。
 */
export type RuleEvaluator = (input: RuleInput) => number;

/** 折出小數時四捨五入到分。 */
function percentageOf(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

function capped(discountCents: number, maxDiscountCents: number | null | undefined): number {
  if (maxDiscountCents === null || maxDiscountCents === undefined) return discountCents;
  return Math.min(discountCents, maxDiscountCents);
}

const evaluators: Record<string, RuleEvaluator> = {
  threshold_fixed_amount: ({ rule, subtotalCents }) => {
    if (rule.type !== 'threshold_fixed_amount') return 0;
    if (subtotalCents < rule.thresholdCents) return 0;
    return rule.discountCents;
  },

  threshold_percentage: ({ rule, subtotalCents, remainingCents }) => {
    if (rule.type !== 'threshold_percentage') return 0;
    if (subtotalCents < rule.thresholdCents) return 0;
    return capped(percentageOf(remainingCents, rule.percentOffBasisPoints), rule.maxDiscountCents);
  },

  order_percentage: ({ rule, remainingCents }) => {
    if (rule.type !== 'order_percentage') return 0;
    return capped(percentageOf(remainingCents, rule.percentOffBasisPoints), rule.maxDiscountCents);
  },
};

/** 新增規則型別只需要在這裡多一個 evaluator，引擎的流程不動。 */
export function evaluateRule(input: RuleInput): number {
  const evaluator = evaluators[input.rule.type];
  if (!evaluator) return 0;
  return Math.max(0, Math.trunc(evaluator(input)));
}
