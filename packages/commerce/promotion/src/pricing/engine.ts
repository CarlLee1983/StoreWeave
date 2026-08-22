import { allocateByAmount } from './allocation';
import { assertValidPricingInput } from './input';
import { evaluateRule } from './rules';
import type {
  Adjustment,
  ThresholdHint,
  AppliedPromotion,
  PricedLine,
  PricingInput,
  PricingLineInput,
  PricingResult,
  Promotion,
} from './types';

export function lineTotalCents(line: PricingLineInput): number {
  return line.unitPriceCents * line.quantity;
}

export function subtotalOf(lines: readonly PricingLineInput[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

/** 等級限定的活動只對名單上的等級套用。未登入（沒有等級）一律不符。 */
function appliesToTier(promotion: Promotion, membershipTier: string | null | undefined): boolean {
  if (!promotion.tierNames || promotion.tierNames.length === 0) return true;
  return membershipTier !== null && membershipTier !== undefined && promotion.tierNames.includes(membershipTier);
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

/** 規則裡的門檻。沒有門檻的規則型別回 null——那種活動沒有「還差多少」可言。 */
function thresholdOf(promotion: Promotion): number | null {
  return promotion.rule.type === 'threshold_fixed_amount' || promotion.rule.type === 'threshold_percentage'
    ? promotion.rule.thresholdCents
    : null;
}

/**
 * 最接近、但還沒達成的門檻。差距相同時沿用套用順序（優先序、然後 id），
 * 輸出因此與輸入陣列的排列無關。
 */
function nextThresholdOf(
  promotions: readonly Promotion[],
  subtotalCents: number,
  now: Date,
  membershipTier: string | null | undefined,
): ThresholdHint | null {
  let best: ThresholdHint | null = null;
  for (const promotion of inApplicationOrder(promotions)) {
    if (!isActive(promotion, now)) continue;
    // 套不到的活動不該出現在「還差多少」裡：那只是讓顧客白跑一趟。
    if (!appliesToTier(promotion, membershipTier)) continue;
    const thresholdCents = thresholdOf(promotion);
    if (thresholdCents === null || subtotalCents >= thresholdCents) continue;
    const remainingCents = thresholdCents - subtotalCents;
    if (best && best.remainingCents <= remainingCents) continue;
    best = { promotionId: promotion.id, name: promotion.name, thresholdCents, remainingCents };
  }
  return best;
}

/**
 * 定價引擎。輸入購物內容、情境與當下時間，輸出調整明細與總額。
 * 純函式：不碰資料庫、不讀時鐘、不修改輸入。
 */
export function calculatePricing(input: PricingInput): PricingResult {
  assertValidPricingInput(input);

  const subtotalCents = subtotalOf(input.lines);
  const shippingCents = input.shippingCents ?? 0;
  const taxCents = input.taxCents ?? 0;

  const lineTotals = input.lines.map(lineTotalCents);
  const pricedLines: PricedLine[] = input.lines.map((line, index) => ({
    lineId: line.lineId,
    lineTotalCents: lineTotals[index],
    discountCents: 0,
    netCents: lineTotals[index],
    adjustments: [],
  }));

  const adjustments: Adjustment[] = [];
  const appliedPromotions: AppliedPromotion[] = [];
  let discountCents = 0;
  let exclusiveApplied = false;

  for (const promotion of inApplicationOrder(input.context.promotions)) {
    if (!isActive(promotion, input.now)) continue;
    if (!appliesToTier(promotion, input.context.membershipTier)) continue;
    // 不可疊加的活動一旦套用，後續不可疊加的活動就出局；可疊加的活動不受影響。
    if (!promotion.stackable && exclusiveApplied) continue;

    const wanted = evaluateRule({
      rule: promotion.rule,
      lines: input.lines,
      subtotalCents,
      remainingCents: subtotalCents - discountCents,
    });
    // 折扣總額不得超過商品小計，否則會出現負數訂單。
    const granted = Math.min(wanted, subtotalCents - discountCents);
    if (granted <= 0) continue;

    discountCents += granted;
    if (!promotion.stackable) exclusiveApplied = true;
    adjustments.push({
      source: 'promotion',
      sourceId: promotion.id,
      name: promotion.name,
      amountCents: -granted,
    });

    // 訂單層的折扣一定攤回商品行——沒有它，第一次部分退貨就算不回來。
    // 比例的基準是原始行金額而不是當下實收：分攤比例因此不隨套用順序改變，
    // 「這一行佔訂單多少」永遠是同一個答案。容量才用當下實收，讓沒有一行被折成負數。
    const shares = allocateByAmount(
      lineTotals,
      granted,
      pricedLines.map((line) => line.netCents),
    );
    shares.forEach((share, index) => {
      if (share <= 0) return;
      const line = pricedLines[index];
      line.discountCents += share;
      line.netCents -= share;
      line.adjustments.push({
        source: 'promotion',
        sourceId: promotion.id,
        name: promotion.name,
        amountCents: -share,
      });
    });
    appliedPromotions.push({ promotionId: promotion.id, name: promotion.name, discountCents: granted });
  }

  // 購物金折抵最後套用：它作用在商品小計上，且不該影響任何活動的門檻判斷。
  const rewardWanted = Math.max(0, Math.trunc(input.rewardRedeemCents ?? 0));
  const rewardGranted = Math.min(rewardWanted, subtotalCents - discountCents);
  if (rewardGranted > 0) {
    discountCents += rewardGranted;
    adjustments.push({ source: 'reward', sourceId: 'reward', name: '購物金折抵', amountCents: -rewardGranted });
    const shares = allocateByAmount(lineTotals, rewardGranted, pricedLines.map((line) => line.netCents));
    shares.forEach((share, index) => {
      if (share <= 0) return;
      const line = pricedLines[index];
      line.discountCents += share;
      line.netCents -= share;
      line.adjustments.push({ source: 'reward', sourceId: 'reward', name: '購物金折抵', amountCents: -share });
    });
  }

  return {
    subtotalCents,
    discountCents,
    rewardRedeemedCents: rewardGranted,
    shippingCents,
    taxCents,
    totalCents: subtotalCents - discountCents + shippingCents + taxCents,
    adjustments,
    appliedPromotions,
    lines: pricedLines,
    nextThreshold: nextThresholdOf(input.context.promotions, subtotalCents, input.now, input.context.membershipTier),
  };
}
