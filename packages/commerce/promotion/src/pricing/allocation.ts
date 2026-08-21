/**
 * 訂單層的調整攤回商品行。
 *
 * 規則：按各行金額比例無條件捨去，剩下的餘數整批給金額最高的那一行；
 * 金額相同時給排序在前的那一行。若那一行裝不下（會讓實收變負數），
 * 依同樣的順序往下一行溢。同樣的輸入永遠得到同樣的結果。
 */
export function allocateByAmount(
  amountsCents: readonly number[],
  totalToAllocateCents: number,
  /** 每一行最多能吸收多少。預設是自己的金額，實收因此不會為負。 */
  capacitiesCents: readonly number[] = amountsCents,
): number[] {
  if (capacitiesCents.length !== amountsCents.length) {
    throw new Error(
      `allocateByAmount: capacities length ${capacitiesCents.length} does not match amounts length ${amountsCents.length}`,
    );
  }

  const shares = amountsCents.map(() => 0);
  const base = amountsCents.reduce((sum, amount) => sum + amount, 0);
  if (base <= 0 || totalToAllocateCents <= 0) return shares;

  let allocated = 0;
  for (let i = 0; i < amountsCents.length; i += 1) {
    const share = Math.min(
      Math.floor((totalToAllocateCents * amountsCents[i]) / base),
      capacitiesCents[i],
    );
    shares[i] = share;
    allocated += share;
  }

  // 餘數：金額高的優先，金額相同時排序在前的優先。
  const byAmountDesc = shares
    .map((_, index) => index)
    .sort((a, b) => amountsCents[b] - amountsCents[a] || a - b);

  let remainder = totalToAllocateCents - allocated;
  for (const index of byAmountDesc) {
    if (remainder <= 0) break;
    const room = capacitiesCents[index] - shares[index];
    if (room <= 0) continue;
    const take = Math.min(room, remainder);
    shares[index] += take;
    remainder -= take;
  }

  // 分不完代表呼叫端給的容量不足。靜默少分會產生一筆對不起來的帳，寧可出聲。
  if (remainder > 0) {
    throw new Error(`allocateByAmount: cannot allocate ${remainder} cents; capacities are exhausted`);
  }

  return shares;
}
