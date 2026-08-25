import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpStatusOf } from '@storeweave/contracts';
import { ADMIN_ACTOR, actorWith, createHarness, type TestHarness } from './helpers';

/** 工單 72：等級與購物金設定的營運介面。這裡守的是設定本身的不變式。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const save = (tier: { name: string; thresholdPoints: number; multiplierBasisPoints: number }, actor = ADMIN_ACTOR) =>
  h.runtime.commands.execute('commerce.loyalty.saveTier', tier, { actor });
const tiers = () => h.runtime.queries.execute<{ items: { name: string; thresholdPoints: number }[] }>('commerce.loyalty.listTiers', {}, { actor: ADMIN_ACTOR });

describe('等級的門檻', () => {
  it('拒絕把兩個等級放在同一個門檻上，而不是丟一個看不懂的 500', async () => {
    // 斷言的是「這是一個講得出理由的 400」，不是訊息裡剛好有 threshold 這個字——
    // 唯一索引撞上去時丟的 500 訊息裡也有，那樣的斷言會綠得毫無意義。
    const existing = (await tiers()).items.find((tier) => tier.thresholdPoints > 0)!;
    const failure = await save({ name: 'ops-duplicate', thresholdPoints: existing.thresholdPoints, multiplierBasisPoints: 12_000 }).catch((error) => error);
    expect(httpStatusOf(failure)).toBe(400);
    expect(String(failure)).toMatch(/threshold/i);
  });

  it('同名視為修改，改自己的門檻不算撞到自己', async () => {
    await save({ name: 'ops-editable', thresholdPoints: 7_777, multiplierBasisPoints: 12_000 });
    await save({ name: 'ops-editable', thresholdPoints: 8_888, multiplierBasisPoints: 12_000 });
    expect((await tiers()).items.filter((tier) => tier.name === 'ops-editable')).toEqual([
      expect.objectContaining({ thresholdPoints: 8_888 }),
    ]);
  });

  it('不讓保底等級把門檻抬離零：沒有零門檻的等級，新會員不屬於任何等級', async () => {
    const base = (await tiers()).items.find((tier) => tier.thresholdPoints === 0)!;
    await expect(save({ name: base.name, thresholdPoints: 500, multiplierBasisPoints: 10_000 }))
      .rejects.toThrow(/zero threshold/i);
  });
});

describe('移除等級', () => {
  it('移除不存在的等級是 404，不是靜默成功', async () => {
    await expect(h.runtime.commands.execute('commerce.loyalty.removeTier', { name: 'ops-never-existed' }, { actor: ADMIN_ACTOR }))
      .rejects.toThrow(/not found/i);
  });
});

describe('loyalty:write 是自己的鍵', () => {
  it('只有 promotion:write 的身分改不動等級與購物金設定', async () => {
    const promoOnly = actorWith(['promotion:read', 'promotion:write']);
    await expect(save({ name: 'ops-forbidden', thresholdPoints: 9_999, multiplierBasisPoints: 12_000 }, promoOnly))
      .rejects.toThrow(/permission|forbidden/i);
    await expect(h.runtime.commands.execute('commerce.loyalty.updateRewardSettings', { accrualBasisPoints: 500 }, { actor: promoOnly }))
      .rejects.toThrow(/permission|forbidden/i);
  });
});
