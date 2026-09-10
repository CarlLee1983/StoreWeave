import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { couponPages } from '../src/pages';

const customer: Actor = { id: 'cust-1', type: 'customer', permissions: [] };

const coupon = (over: Record<string, unknown> = {}) => ({
  code: 'WELCOME100', promotionName: '新會員禮', description: '折抵 100 元',
  status: 'issued' as const, endsAt: null, expiringSoon: false, usable: true, unusableReason: null,
  ...over,
});

const ctxWith = (execute: PageResolveContext['queries']['execute']): PageResolveContext => ({
  queries: { execute },
  commands: { execute: vi.fn() },
  actor: customer,
  locale: 'zh-TW',
  clientKey: 'test-client',
  cookies: { guestCartToken: () => null, ensureGuestCart: () => 'guest-token' },
  providers: {
    get: () => { throw new Error('我的券頁不需要 provider'); },
    has: () => false,
  },
});

describe('我的券頁', () => {
  it('原樣列出查詢回傳的券', async () => {
    const execute = vi.fn(async () => ({ items: [coupon()] }));

    const outcome = await couponPages.accountList.resolve(ctxWith(execute as never), {});

    expect(execute).toHaveBeenCalledWith('commerce.coupon.listMyCoupons', {}, { actor: customer });
    expect(outcome).toEqual({ kind: 'view', view: { coupons: [coupon()] } });
  });

  it('沒有券時是空陣列', async () => {
    const execute = vi.fn(async () => ({ items: [] }));

    const outcome = await couponPages.accountList.resolve(ctxWith(execute as never), {});

    expect(outcome).toEqual({ kind: 'view', view: { coupons: [] } });
  });
});
