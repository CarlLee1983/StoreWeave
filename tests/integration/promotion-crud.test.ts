import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import { ADMIN_ACTOR, actorWith, createHarness, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const create = (input: Record<string, unknown>, actor = ADMIN_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.promotion.createPromotion', input, { actor });

const fixedRule = { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 };

describe('促銷活動的建立與管理', () => {
  it('建立後查得回同一筆，優先序與可否疊加是活動自己的屬性', async () => {
    const created = await create({
      name: '滿千折百',
      rule: fixedRule,
      priority: 20,
      stackable: false,
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
    });

    const found = await h.runtime.queries.execute<any>(
      'commerce.promotion.getPromotion', { id: created.id }, { actor: ADMIN_ACTOR },
    );

    expect(found.name).toBe('滿千折百');
    expect(found.status).toBe('active');
    expect(found.rule).toEqual(fixedRule);
    expect(found.priority).toBe(20);
    expect(found.stackable).toBe(false);
    expect(new Date(found.startsAt).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(found).not.toHaveProperty('rule_type');
  });

  /** 驗證錯誤的欄位資訊在 PlatformError.details 裡，訊息本身是通用的。 */
  async function rejectedFields(input: Record<string, unknown>): Promise<string[]> {
    try {
      await create(input);
      throw new Error('expected the command to be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformError);
      const issues = (err as PlatformError).details as { path: (string | number)[] }[];
      return issues.map((issue) => issue.path.join('.'));
    }
  }

  it('不合法的規則參數被拒絕，錯誤指得出是哪一個欄位', async () => {
    expect(await rejectedFields({ name: '折零元', rule: { ...fixedRule, discountCents: 0 } }))
      .toContain('rule.discountCents');
    expect(await rejectedFields({ name: '超過百分之百', rule: { type: 'order_percentage', percentOffBasisPoints: 10_001 } }))
      .toContain('rule.percentOffBasisPoints');
    expect(await rejectedFields({ name: '不認得的型別', rule: { type: 'buy_x_get_y', quantity: 2 } }))
      .toContain('rule.type');
  });

  it('結束時間早於開始時間的活動建不出來', async () => {
    expect(await rejectedFields({
      name: '倒著設的期間',
      rule: fixedRule,
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-09-01T00:00:00.000Z',
    })).toContain('endsAt');
  });

  it('編輯只改指定的欄位，期間只改一半時仍與資料庫裡的另一半比對', async () => {
    const created = await create({
      name: '九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
    });

    const updated = await h.runtime.commands.execute<any>(
      'commerce.promotion.updatePromotion',
      { id: created.id, name: '八折', rule: { type: 'order_percentage', percentOffBasisPoints: 2_000 } },
      { actor: ADMIN_ACTOR },
    );
    expect(updated.name).toBe('八折');
    expect(updated.rule.percentOffBasisPoints).toBe(2_000);
    expect(new Date(updated.endsAt).toISOString()).toBe('2026-10-01T00:00:00.000Z');

    await expect(h.runtime.commands.execute('commerce.promotion.updatePromotion',
      { id: created.id, endsAt: '2026-08-01T00:00:00.000Z' }, { actor: ADMIN_ACTOR },
    )).rejects.toThrow(/endsAt/);
  });

  it('停用後仍查得到，但不再出現在「此刻生效中」的清單', async () => {
    const created = await create({ name: '要被停用的活動', rule: fixedRule });

    const beforeList = await h.runtime.queries.execute<any>(
      'commerce.promotion.listPromotions', { activeAt: new Date().toISOString() }, { actor: ADMIN_ACTOR },
    );
    expect(beforeList.items.map((p: any) => p.id)).toContain(created.id);

    const disabled = await h.runtime.commands.execute<any>(
      'commerce.promotion.setPromotionStatus', { id: created.id, status: 'disabled' }, { actor: ADMIN_ACTOR },
    );
    expect(disabled.status).toBe('disabled');

    const afterList = await h.runtime.queries.execute<any>(
      'commerce.promotion.listPromotions', { activeAt: new Date().toISOString() }, { actor: ADMIN_ACTOR },
    );
    expect(afterList.items.map((p: any) => p.id)).not.toContain(created.id);

    const still = await h.runtime.queries.execute<any>(
      'commerce.promotion.getPromotion', { id: created.id }, { actor: ADMIN_ACTOR },
    );
    expect(still.id).toBe(created.id);
  });

  it('清單依優先序排序，且「此刻生效中」看的是活動期間', async () => {
    const future = await create({
      name: '還沒開始',
      rule: fixedRule,
      priority: -10,
      startsAt: '2099-01-01T00:00:00.000Z',
    });
    const past = await create({
      name: '已經結束',
      rule: fixedRule,
      priority: -20,
      endsAt: '2000-01-01T00:00:00.000Z',
    });

    const active = await h.runtime.queries.execute<any>(
      'commerce.promotion.listPromotions', { activeAt: new Date().toISOString() }, { actor: ADMIN_ACTOR },
    );
    const ids = active.items.map((p: any) => p.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(past.id);

    const all = await h.runtime.queries.execute<any>('commerce.promotion.listPromotions', {}, { actor: ADMIN_ACTOR });
    const priorities = all.items.map((p: any) => p.priority);
    expect([...priorities].sort((a: number, b: number) => a - b)).toEqual(priorities);
  });

  it('每一次寫入都留下稽核紀錄', async () => {
    const created = await create({ name: '要被稽核的活動', rule: fixedRule });
    await h.runtime.commands.execute('commerce.promotion.updatePromotion',
      { id: created.id, name: '改過名字' }, { actor: ADMIN_ACTOR });
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
      { id: created.id, status: 'disabled' }, { actor: ADMIN_ACTOR });

    const rows = await h.runtime.database.db.execute<{ action: string; actor_type: string }>(sql`
      SELECT action, actor_type FROM platform_audit_log
      WHERE resource_type = 'promotion' AND resource_id = ${created.id}
      ORDER BY occurred_at
    `);
    expect(rows.rows.map((r) => r.action)).toEqual([
      'promotion.created', 'promotion.updated', 'promotion.status-changed',
    ]);
    expect(rows.rows.every((r) => r.actor_type === 'user')).toBe(true);
  });

  it('只有讀取權限的人建不了活動', async () => {
    await expect(create({ name: '越權建立', rule: fixedRule }, actorWith(['promotion:read'])))
      .rejects.toThrow(/Forbidden/);
  });
});
