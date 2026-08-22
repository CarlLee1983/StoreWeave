import { describe, expect, it } from 'vitest';
import { deriveTier, multiplierOf, tierWindowStart, type TierDefinition, type TierEntry } from '@storeweave/loyalty';

/** 會員等級的推導（工單 43）。 */

const AT = (iso: string) => new Date(iso);
const NOW = AT('2026-08-22T00:00:00.000Z');

const TIERS: TierDefinition[] = [
  { name: '一般會員', thresholdPoints: 0, multiplierBasisPoints: 10_000 },
  { name: '銀卡', thresholdPoints: 3_000, multiplierBasisPoints: 12_000 },
  { name: '金卡', thresholdPoints: 10_000, multiplierBasisPoints: 15_000 },
];

let seq = 0;
const entry = (points: number, earnedAt: string): TierEntry => {
  seq += 1;
  return { id: `t${seq}`, points, earnedAt: AT(earnedAt) };
};

describe('滾動十二個月', () => {
  it('期間的起點是往前推十二個月', () => {
    expect(tierWindowStart(AT('2026-08-22T00:00:00.000Z'))).toEqual(AT('2025-08-22T00:00:00.000Z'));
  });

  it('只算期間內的積分', () => {
    const status = deriveTier([
      entry(5_000, '2026-08-01T00:00:00.000Z'),
      entry(9_000, '2024-01-01T00:00:00.000Z'),
    ], TIERS, NOW);

    expect(status.points).toBe(5_000);
    expect(status.current.name).toBe('銀卡');
  });

  it('落在期間起點那一刻的分錄算進來，前一毫秒的不算', () => {
    const start = tierWindowStart(NOW);
    expect(deriveTier([entry(3_000, start.toISOString())], TIERS, NOW).points).toBe(3_000);
    expect(deriveTier([{ id: 'x', points: 3_000, earnedAt: new Date(start.getTime() - 1) }], TIERS, NOW).points).toBe(0);
  });

  it('會降級：同一批積分過了十二個月就不算了', () => {
    const entries = [entry(10_000, '2025-09-01T00:00:00.000Z')];

    expect(deriveTier(entries, TIERS, AT('2026-08-01T00:00:00.000Z')).current.name).toBe('金卡');
    // 一年後那筆積分掉出期間，等級跟著回到最低。
    expect(deriveTier(entries, TIERS, AT('2026-09-02T00:00:00.000Z')).current.name).toBe('一般會員');
  });

  it('扣回的負分錄會拉低積分', () => {
    const status = deriveTier([
      entry(5_000, '2026-08-01T00:00:00.000Z'),
      entry(-3_000, '2026-08-10T00:00:00.000Z'),
    ], TIERS, NOW);

    expect(status.points).toBe(2_000);
    expect(status.current.name).toBe('一般會員');
  });

  it('積分不會是負的', () => {
    expect(deriveTier([entry(-5_000, '2026-08-01T00:00:00.000Z')], TIERS, NOW).points).toBe(0);
  });
});

describe('等級與下一級', () => {
  it('沒有積分時是最低的那一級', () => {
    const status = deriveTier([], TIERS, NOW);
    expect(status.current.name).toBe('一般會員');
    expect(status.next).toMatchObject({ remainingPoints: 3_000 });
    expect(status.next!.tier.name).toBe('銀卡');
  });

  it('剛好達到門檻就是那一級', () => {
    expect(deriveTier([entry(3_000, '2026-08-01T00:00:00.000Z')], TIERS, NOW).current.name).toBe('銀卡');
  });

  it('說得出離下一級還差多少', () => {
    const status = deriveTier([entry(4_500, '2026-08-01T00:00:00.000Z')], TIERS, NOW);
    expect(status.next).toMatchObject({ remainingPoints: 5_500 });
    expect(status.next!.tier.name).toBe('金卡');
  });

  it('已經是最高級時沒有下一級', () => {
    expect(deriveTier([entry(20_000, '2026-08-01T00:00:00.000Z')], TIERS, NOW).next).toBeNull();
  });

  it('門檻的順序由資料決定，不是由輸入陣列的排列決定', () => {
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]];
    expect(deriveTier([entry(4_000, '2026-08-01T00:00:00.000Z')], shuffled, NOW).current.name).toBe('銀卡');
  });

  it('說得出期間的起點——降級時要解釋得了為什麼', () => {
    expect(deriveTier([], TIERS, NOW).windowStartsAt).toEqual(AT('2025-08-22T00:00:00.000Z'));
  });
});

describe('倍率', () => {
  it('基點換算成倍數', () => {
    expect(multiplierOf(TIERS[0])).toBe(1);
    expect(multiplierOf(TIERS[1])).toBe(1.2);
    expect(multiplierOf(TIERS[2])).toBe(1.5);
  });
});
