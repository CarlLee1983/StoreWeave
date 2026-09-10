import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { createLoyaltyPages } from '../src/pages';

const customer: Actor = { id: 'cust-1', type: 'customer', permissions: [] };

const rewardsResult = (over: Record<string, unknown> = {}) => ({
  balance: { availableCents: 1000, pendingCents: 0, expiredCents: 0, nextExpiry: null },
  entries: [
    { amountCents: 500, source: 'order-accrual', reason: null, effectiveAt: new Date('2026-01-01'), expiresAt: null, createdAt: new Date('2026-01-01') },
  ],
  ...over,
});

const tierResult = (over: Record<string, unknown> = {}) => ({
  current: { name: '銀卡' },
  points: 300,
  next: { tier: { name: '金卡' }, remainingPoints: 200 },
  windowStartsAt: new Date('2026-01-01'),
  windowMonths: 12,
  ...over,
});

const ctxWith = (execute: PageResolveContext['queries']['execute']): PageResolveContext => ({
  queries: { execute },
  commands: { execute: vi.fn() },
  actor: customer,
  locale: 'zh-TW',
});

describe('購物金與等級頁', () => {
  const loyaltyPages = createLoyaltyPages({ currency: 'TWD' });

  it('組合購物金與等級，幣別來自模組設定', async () => {
    const execute = vi.fn(async (name: string) =>
      name === 'commerce.loyalty.getMyRewards' ? rewardsResult() : tierResult());

    const outcome = await loyaltyPages.rewards.resolve(ctxWith(execute as never), {});

    expect(execute).toHaveBeenCalledWith('commerce.loyalty.getMyRewards', {}, { actor: customer });
    expect(execute).toHaveBeenCalledWith('commerce.loyalty.getMyTier', {}, { actor: customer });
    expect(outcome).toMatchObject({
      kind: 'view',
      view: {
        currency: 'TWD',
        balance: { availableCents: 1000 },
        entries: [{ amountCents: 500, description: '購物回饋' }],
        tier: { name: '銀卡', points: 300, next: { name: '金卡', remainingPoints: 200 } },
      },
    });
  });

  it('沒有下一級時 next 是 null', async () => {
    const execute = vi.fn(async (name: string) =>
      name === 'commerce.loyalty.getMyRewards' ? rewardsResult() : tierResult({ next: null }));

    const outcome = await loyaltyPages.rewards.resolve(ctxWith(execute as never), {});

    expect(outcome).toMatchObject({ view: { tier: { next: null } } });
  });

  it('有客服補償原因時原樣顯示，不用預設說法', async () => {
    const execute = vi.fn(async (name: string) => name === 'commerce.loyalty.getMyRewards'
      ? rewardsResult({ entries: [{ amountCents: 200, source: 'manual', reason: '客服補償運費', effectiveAt: new Date(), expiresAt: null, createdAt: new Date() }] })
      : tierResult());

    const outcome = await loyaltyPages.rewards.resolve(ctxWith(execute as never), {});

    expect(outcome).toMatchObject({ view: { entries: [{ description: '客服補償運費' }] } });
  });

  it('未知來源代碼時說法是「調整」', async () => {
    const execute = vi.fn(async (name: string) => name === 'commerce.loyalty.getMyRewards'
      ? rewardsResult({ entries: [{ amountCents: 200, source: 'unknown-source', reason: null, effectiveAt: new Date(), expiresAt: null, createdAt: new Date() }] })
      : tierResult());

    const outcome = await loyaltyPages.rewards.resolve(ctxWith(execute as never), {});

    expect(outcome).toMatchObject({ view: { entries: [{ description: '調整' }] } });
  });
});
