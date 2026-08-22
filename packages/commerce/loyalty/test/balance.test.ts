import { describe, expect, it } from 'vitest';
import { deriveRewardBalance, maxRedeemableCents, type RewardEntry } from '@storeweave/loyalty';

/** 購物金餘額的推導（工單 40）。餘額是帳本的推導值，沒有餘額欄位可以斷言。 */

const AT = (iso: string) => new Date(iso);
const NOW = AT('2026-08-22T00:00:00.000Z');

let seq = 0;
function entry(overrides: Partial<RewardEntry> & { amountCents: number }): RewardEntry {
  seq += 1;
  return {
    id: `e${String(seq).padStart(3, '0')}`,
    source: overrides.amountCents > 0 ? 'manual' : 'redemption',
    effectiveAt: AT('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    createdAt: AT('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('可用餘額', () => {
  it('沒有任何分錄時全部是零', () => {
    expect(deriveRewardBalance([], NOW)).toMatchObject({ availableCents: 0, pendingCents: 0, expiredCents: 0 });
  });

  it('已生效且未過期的批次算進可用餘額', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 300, expiresAt: AT('2027-01-01T00:00:00.000Z') }),
      entry({ amountCents: 200 }),
    ], NOW);

    expect(balance.availableCents).toBe(500);
  });

  it('還沒生效的批次是 pending，不能用', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 1_000, effectiveAt: AT('2026-09-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance).toMatchObject({ availableCents: 0, pendingCents: 1_000 });
  });

  it('已經過期的批次不算可用，但說得出過期了多少', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 800, expiresAt: AT('2026-08-01T00:00:00.000Z') }),
      entry({ amountCents: 200 }),
    ], NOW);

    expect(balance).toMatchObject({ availableCents: 200, expiredCents: 800 });
  });

  it('到期判斷含頭不含尾：到期當下那一刻就不能用了', () => {
    const at = AT('2026-08-22T00:00:00.000Z');
    expect(deriveRewardBalance([entry({ amountCents: 100, expiresAt: at })], at).availableCents).toBe(0);
    expect(deriveRewardBalance([entry({ amountCents: 100, expiresAt: at })], new Date(at.getTime() - 1)).availableCents)
      .toBe(100);
  });

  it('生效判斷含頭：生效當下那一刻就能用', () => {
    const at = AT('2026-08-22T00:00:00.000Z');
    expect(deriveRewardBalance([entry({ amountCents: 100, effectiveAt: at })], at).availableCents).toBe(100);
  });
});

describe('先到期的先用', () => {
  it('扣抵優先用掉快到期的那一批', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 500, expiresAt: AT('2027-01-01T00:00:00.000Z'), createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: 500, expiresAt: AT('2026-09-01T00:00:00.000Z'), createdAt: AT('2026-03-01T00:00:00.000Z') }),
      entry({ amountCents: -300, createdAt: AT('2026-04-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.availableCents).toBe(700);
    // 先扣快到期的那一批：它只剩 200，另一批完好。
    const soonest = balance.batches[0];
    expect(soonest.expiresAt).toEqual(AT('2026-09-01T00:00:00.000Z'));
    expect(soonest.remainingCents).toBe(200);
    expect(balance.batches[1].remainingCents).toBe(500);
  });

  it('不過期的批次排在最後才被用掉', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 100, createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: 100, expiresAt: AT('2026-12-01T00:00:00.000Z'), createdAt: AT('2026-03-01T00:00:00.000Z') }),
      entry({ amountCents: -100, createdAt: AT('2026-04-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.batches).toHaveLength(1);
    expect(balance.batches[0].expiresAt).toBeNull();
    expect(balance.availableCents).toBe(100);
  });

  it('一筆扣抵可以橫跨多批', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 100, expiresAt: AT('2026-09-01T00:00:00.000Z'), createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: 100, expiresAt: AT('2026-10-01T00:00:00.000Z'), createdAt: AT('2026-02-02T00:00:00.000Z') }),
      entry({ amountCents: -150, createdAt: AT('2026-03-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.availableCents).toBe(50);
    expect(balance.batches).toHaveLength(1);
    expect(balance.batches[0].remainingCents).toBe(50);
  });

  it('扣抵扣的是它當下還沒過期的批次，不是現在的', () => {
    // 這一批在扣抵當下還沒過期，扣得到；到了 now 它已經過期，但也已經被用掉了。
    const balance = deriveRewardBalance([
      entry({ amountCents: 500, expiresAt: AT('2026-06-01T00:00:00.000Z'), createdAt: AT('2026-01-01T00:00:00.000Z') }),
      entry({ amountCents: 500, createdAt: AT('2026-01-02T00:00:00.000Z') }),
      entry({ amountCents: -500, createdAt: AT('2026-05-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.availableCents).toBe(500);
    expect(balance.expiredCents).toBe(0);
  });

  it('回沖是一筆正的分錄，餘額跟著回來', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 1_000, createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: -400, createdAt: AT('2026-03-01T00:00:00.000Z') }),
      entry({ amountCents: 400, createdAt: AT('2026-04-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.availableCents).toBe(1_000);
  });

  it('扣抵超過餘額時不會讓餘額變成負數', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 100, createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: -500, createdAt: AT('2026-03-01T00:00:00.000Z') }),
    ], NOW);

    expect(balance.availableCents).toBe(0);
  });

  it('同一時刻的入帳與扣抵，先算入帳', () => {
    const at = AT('2026-03-01T00:00:00.000Z');
    const balance = deriveRewardBalance([
      entry({ amountCents: -1_000, createdAt: at }),
      entry({ amountCents: 1_000, createdAt: at }),
    ], NOW);

    expect(balance).toMatchObject({ availableCents: 0, pendingCents: 0 });
  });

  it('輸入順序不影響結果', () => {
    const entries = [
      entry({ amountCents: 500, expiresAt: AT('2027-01-01T00:00:00.000Z'), createdAt: AT('2026-02-01T00:00:00.000Z') }),
      entry({ amountCents: 500, expiresAt: AT('2026-09-01T00:00:00.000Z'), createdAt: AT('2026-03-01T00:00:00.000Z') }),
      entry({ amountCents: -300, createdAt: AT('2026-04-01T00:00:00.000Z') }),
    ];

    expect(deriveRewardBalance(entries, NOW)).toEqual(deriveRewardBalance([...entries].reverse(), NOW));
  });

  it('一連串入帳、折抵、回沖、到期之後，帳本總和與可用餘額仍然對得起來', () => {
    const entries = [
      entry({ amountCents: 1_000, createdAt: AT('2026-01-05T00:00:00.000Z'), expiresAt: AT('2026-08-01T00:00:00.000Z') }),
      entry({ amountCents: 2_000, createdAt: AT('2026-02-05T00:00:00.000Z'), expiresAt: AT('2027-02-05T00:00:00.000Z') }),
      entry({ amountCents: -600, createdAt: AT('2026-03-05T00:00:00.000Z') }),
      entry({ amountCents: 600, createdAt: AT('2026-03-06T00:00:00.000Z') }),
      entry({ amountCents: -1_500, createdAt: AT('2026-04-05T00:00:00.000Z') }),
      entry({ amountCents: 500, createdAt: AT('2026-05-05T00:00:00.000Z'), effectiveAt: AT('2026-12-01T00:00:00.000Z') }),
    ];
    const balance = deriveRewardBalance(entries, NOW);
    const ledgerTotal = entries.reduce((sum, e) => sum + e.amountCents, 0);

    // 帳本總和 = 可用 + 未生效 + 已過期。這條等式是「餘額是推導值」的守門員。
    expect(balance.availableCents + balance.pendingCents + balance.expiredCents).toBe(ledgerTotal);
    expect(balance.batches.reduce((sum, b) => sum + b.remainingCents, 0))
      .toBe(balance.availableCents + balance.pendingCents);
  });
});

describe('折抵上限', () => {
  it('是可用餘額與商品小計的較小值', () => {
    expect(maxRedeemableCents(1_000, 5_000)).toBe(1_000);
    expect(maxRedeemableCents(9_000, 5_000)).toBe(5_000);
  });

  it('永遠不為負', () => {
    expect(maxRedeemableCents(-100, 5_000)).toBe(0);
    expect(maxRedeemableCents(1_000, 0)).toBe(0);
  });
});

describe('折抵與扣回的差別', () => {
  it('折抵扣不到還沒生效的批次——顧客花不到那筆錢', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 1_000, createdAt: AT('2026-02-01T00:00:00.000Z'), effectiveAt: AT('2026-12-01T00:00:00.000Z') }),
      { ...entry({ amountCents: -1_000, createdAt: AT('2026-03-01T00:00:00.000Z') }), source: 'redemption' },
    ], NOW);

    // 那一批仍然完好地掛在未生效，折抵沒有吃到它。
    expect(balance.pendingCents).toBe(1_000);
    expect(balance.availableCents).toBe(0);
    // 折抵扣不到就是帳本壞了，這件事要說得出來。
    expect(balance.shortfallCents).toBe(1_000);
  });

  it('取消時的扣回扣得到還沒生效的批次——那正是生效日存在的理由', () => {
    const balance = deriveRewardBalance([
      entry({ amountCents: 1_000, createdAt: AT('2026-02-01T00:00:00.000Z'), effectiveAt: AT('2026-12-01T00:00:00.000Z') }),
      { ...entry({ amountCents: -1_000, createdAt: AT('2026-03-01T00:00:00.000Z') }), source: 'reversal' },
    ], NOW);

    expect(balance.pendingCents).toBe(0);
    expect(balance.availableCents).toBe(0);
    // 扣回扣不到只代表那筆錢已經花掉，不是異常。
    expect(balance.shortfallCents).toBe(0);
  });

  it('扣回超過剩餘不算短缺，折抵超過剩餘才算', () => {
    const clawback = deriveRewardBalance([
      { ...entry({ amountCents: -500, createdAt: AT('2026-03-01T00:00:00.000Z') }), source: 'reversal' },
    ], NOW);
    const redemption = deriveRewardBalance([
      { ...entry({ amountCents: -500, createdAt: AT('2026-03-01T00:00:00.000Z') }), source: 'redemption' },
    ], NOW);

    expect(clawback.shortfallCents).toBe(0);
    expect(redemption.shortfallCents).toBe(500);
  });
});
