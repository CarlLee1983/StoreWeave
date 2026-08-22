import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { CouponRepository } from './repository';
import type { CouponRow } from './schema';

const repository = new CouponRepository();

/**
 * 券為什麼不能用。分得這麼細不是為了好看：顧客看到「無效」只會再打一次，
 * 看到「已過期」才會去找別張。
 */
export type CouponRejection =
  | 'not_found'
  | 'not_started'
  | 'expired'
  | 'void'
  | 'used'
  | 'not_eligible'
  | 'used_up'
  | 'already_redeemed';

const MESSAGES: Record<CouponRejection, string> = {
  not_found: '找不到這組折扣碼。',
  not_started: '這組折扣碼還沒開始生效。',
  expired: '這組折扣碼已經過期。',
  void: '這組折扣碼已經停用。',
  used: '這張券已經使用過了。',
  not_eligible: '這組折扣碼不適用於這個帳號。',
  // 試算不鎖券，因此「剛剛還看得到折扣」與「現在沒了」都是真的。訊息要講出這件事，
  // 而不是讓顧客以為自己看錯了。
  used_up: '這組折扣碼的數量剛剛用完了（試算時不會保留額度）。請移除後再結帳。',
  already_redeemed: '這檔優惠你已經用過了。',
};

export type CouponResolution =
  | { ok: true; coupon: CouponRow }
  | { ok: false; reason: CouponRejection; message: string };

export function couponError(reason: CouponRejection): PlatformError {
  const code = reason === 'not_found'
    ? 'NOT_FOUND'
    // 搶輸與重複使用是狀態衝突，不是輸入錯誤：同一個請求晚一點送可能就成立了。
    : reason === 'used_up' || reason === 'already_redeemed' ? 'CONFLICT' : 'VALIDATION_ERROR';
  return new PlatformError(code, MESSAGES[reason], { reason });
}

/**
 * 券的核心判斷。試算與結帳都走這裡——兩邊各判一次「這張券能不能用」，
 * 遲早會有一邊多放行一種情況。
 *
 * 這一支**不**扣任何額度：限量的扣減只發生在結帳（工單 32），
 * 因此試算成功不保證結帳成功。這個落差是刻意的，UI 要誠實呈現。
 */
export const couponService = {
  messageFor(reason: CouponRejection): string {
    return MESSAGES[reason];
  },

  async resolve(
    db: DrizzleDb | Tx,
    input: { code: string; customerId: string | null; now: Date },
  ): Promise<CouponResolution> {
    const coupon = await repository.findByCode(db, input.code);
    if (!coupon) return { ok: false, reason: 'not_found', message: MESSAGES.not_found };
    return this.check(coupon, input);
  },

  /** 已經拿到那一列時的判斷。核銷會先鎖列再呼叫它，避免多讀一次。 */
  check(coupon: CouponRow, input: { customerId: string | null; now: Date }): CouponResolution {
    const reject = (reason: CouponRejection): CouponResolution =>
      ({ ok: false, reason, message: MESSAGES[reason] });

    if (coupon.status === 'void') return reject('void');
    if (coupon.status === 'used') return reject('used');
    // 生效期間含頭不含尾，與定價引擎的判斷逐字相同。
    if (coupon.startsAt && input.now.getTime() < coupon.startsAt.getTime()) return reject('not_started');
    if (coupon.endsAt && input.now.getTime() >= coupon.endsAt.getTime()) return reject('expired');
    // 實發券綁定擁有者：別人猜中碼也用不了。
    if (coupon.customerId && coupon.customerId !== input.customerId) return reject('not_eligible');
    // 總量在這裡只是「看得出來已經沒了」。真正的權威是結帳時的條件更新——
    // 讀到還有剩不代表扣得到。
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) return reject('used_up');
    return { ok: true, coupon };
  },

  /**
   * 核銷時的額度扣減。與 `check` 分開：`check` 沒有副作用、試算也走它，
   * 這一支只在結帳的交易內呼叫一次。
   *
   * 順序是先驗每人次數、再扣總量：反過來的話搶輸的人會白扣掉一個名額。
   */
  async consume(
    tx: Tx,
    coupon: CouponRow,
    input: { customerId: string; now: Date },
  ): Promise<CouponResolution> {
    if (coupon.perCustomerLimit !== null) {
      const used = await repository.redemptionCountFor(tx, coupon.promotionId, input.customerId);
      if (used >= coupon.perCustomerLimit) {
        return { ok: false, reason: 'already_redeemed', message: MESSAGES.already_redeemed };
      }
    }
    const consumed = await repository.consume(tx, coupon.id, input.now);
    if (!consumed) return { ok: false, reason: 'used_up', message: MESSAGES.used_up };
    return { ok: true, coupon };
  },
};

export { CouponRepository };
