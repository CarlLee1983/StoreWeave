import type { PricingLineInput, PromotionRule } from './types';

export interface RuleInput {
  rule: PromotionRule;
  lines: readonly PricingLineInput[];
  subtotalCents: number;
}

/**
 * 一條規則算出來的折扣（正數）。回傳 0 表示條件不成立。
 * 上限與餘數處理由引擎負責，規則只回答「這一條想折多少」。
 */
export type RuleEvaluator = (input: RuleInput) => number;

const evaluators: Record<string, RuleEvaluator> = {
  threshold_fixed_amount: ({ rule, subtotalCents }) => {
    if (rule.type !== 'threshold_fixed_amount') return 0;
    if (subtotalCents < rule.thresholdCents) return 0;
    return rule.discountCents;
  },
};

/** 新增規則型別只需要在這裡多一個 evaluator，引擎的流程不動。 */
export function evaluateRule(input: RuleInput): number {
  const evaluator = evaluators[input.rule.type];
  if (!evaluator) return 0;
  return Math.max(0, Math.trunc(evaluator(input)));
}
