/** Job 執行在交易外，因此只能透過 Command Bus 碰資料庫。 */
type CoreJobContext = {
  executeCommand(name: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  jobId: string;
};

export const BIRTHDAY_COUPONS_JOB = 'commerce.coupon.issue-birthday-coupons';

/**
 * 每日一次的生日禮券。切片機制（ADR 0016）保證每個切片只跑一次，
 * 而「同一個人同一年只發一次」由發放的去重鍵保證——兩層各管各的：
 * 前者管排程，後者管重跑與跨時區的邊界。
 */
export function createBirthdayCouponsJob() {
  return async (_payload: unknown, rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as CoreJobContext;
    await ctx.executeCommand('commerce.coupon.issueBirthdayCoupons', {}, `birthday-coupons:${ctx.jobId}`);
  };
}
