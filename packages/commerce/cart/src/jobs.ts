/** Job 執行在交易外，因此只能透過 Command Bus 碰資料庫。 */
type CoreJobContext = {
  executeCommand(name: string, input: unknown, idempotencyKey: string): Promise<unknown>;
  jobId: string;
};

export const PURGE_STALE_GUEST_CARTS_JOB = 'commerce.cart.purge-stale-guest-carts';

/**
 * 週期性清理。切片機制（ADR 0016）保證每個切片只跑一次，
 * 因此這裡不必自己排下一次，也沒有一條會斷掉的鏈。
 */
export function createPurgeStaleGuestCartsJob() {
  return async (_payload: unknown, rawCtx: unknown): Promise<void> => {
    const ctx = rawCtx as CoreJobContext;
    await ctx.executeCommand('commerce.cart.purgeStaleGuestCarts', {}, `cart-purge:${ctx.jobId}`);
  };
}
