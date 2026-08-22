/** Job 執行在交易外，因此只能透過 Command Bus 碰資料庫。 */
type CoreJobContext = {
  executeCommand(name: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  jobId: string;
};

export const RECALCULATE_TIERS_JOB = 'commerce.loyalty.recalculate-tiers';

/**
 * 每日重算會員等級。
 *
 * 重算算的是「現在的滾動期間內有多少積分」而不是累加，因此重複執行的結果相同；
 * 切片機制（ADR 0016）保證每個切片只排一次，兩者各管各的。
 *
 * 沒跑到的切片不會被追補，但那不影響正確性：等級是帳本的推導值，
 * 少算一天只是快取晚一天更新。
 */
export function createRecalculateTiersJob() {
  return async (_payload: unknown, rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as CoreJobContext;
    await ctx.executeCommand('commerce.loyalty.recalculateTiers', {}, `recalculate-tiers:${ctx.jobId}`);
  };
}
