import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import type { Actor } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { customerPages } from '../src/pages';

const customer: Actor = { id: 'cust-1', type: 'customer', permissions: [] };

const profile = (over: Record<string, unknown> = {}) => ({
  displayName: '林小明', phone: '0912345678', birthday: '1990-01-01',
  address: {
    countryCode: 'TW' as const, recipient: '林小明', phone: '0912345678',
    postcode: '100', city: '台北市', district: '中正區', line1: '仁愛路一段1號', line2: null,
  },
  ...over,
});

const ctxWith = (
  execute: PageResolveContext['queries']['execute'],
  commandExecute: PageResolveContext['commands']['execute'] = vi.fn(),
): PageResolveContext => ({
  queries: { execute },
  commands: { execute: commandExecute },
  actor: customer,
  locale: 'zh-TW',
  clientKey: 'test-client',
  cookies: { guestCartToken: () => null, ensureGuestCart: () => 'guest-token' },
  providers: {
    get: () => { throw new Error('個人資料頁不需要 provider'); },
    has: () => false,
  },
});

describe('個人資料頁', () => {
  it('顯示目前的個人資料', async () => {
    const execute = vi.fn(async () => profile());

    const outcome = await customerPages.profile.resolve(ctxWith(execute as never), {});

    expect(execute).toHaveBeenCalledWith('commerce.customer.getMyProfile', {}, { actor: customer });
    expect(outcome).toMatchObject({ kind: 'view', view: { displayName: '林小明', phone: '0912345678' } });
  });
});

describe('儲存個人資料', () => {
  const parse = (raw: Record<string, string>) => customerPages.saveProfile.input.parse(raw);

  it('填了地址第一行時整組地址一起送出，成功後重新渲染並帶 saved', async () => {
    const commandExecute = vi.fn(async () => ({}));
    const queryExecute = vi.fn(async () => profile());

    const outcome = await customerPages.saveProfile.resolve(
      ctxWith(queryExecute as never, commandExecute as never),
      parse({
        displayName: '林小明', phone: '0912345678', birthday: '1990-01-01',
        recipient: '林小明', addressPhone: '0912345678', postcode: '100', city: '台北市',
        district: '中正區', line1: '仁愛路一段1號', line2: '',
      }),
    );

    expect(commandExecute).toHaveBeenCalledWith('commerce.customer.updateMyProfile', {
      displayName: '林小明', phone: '0912345678', birthday: '1990-01-01',
      address: {
        countryCode: 'TW', recipient: '林小明', phone: '0912345678', postcode: '100',
        city: '台北市', district: '中正區', line1: '仁愛路一段1號', line2: null,
      },
    }, { actor: customer });
    expect(outcome).toMatchObject({ kind: 'view', view: { saved: true } });
  });

  it('沒有填地址第一行時不送地址', async () => {
    const commandExecute = vi.fn(async () => ({}));
    const queryExecute = vi.fn(async () => profile());

    await customerPages.saveProfile.resolve(
      ctxWith(queryExecute as never, commandExecute as never),
      parse({ displayName: '林小明' }),
    );

    expect(commandExecute).toHaveBeenCalledWith('commerce.customer.updateMyProfile', {
      displayName: '林小明', phone: undefined, birthday: undefined, address: undefined,
    }, { actor: customer });
  });

  it('後端拒絕（4xx）時原樣顯示錯誤訊息並重新渲染', async () => {
    const commandExecute = vi.fn(async () => { throw PlatformError.validation('生日已經設定過，不能修改'); });
    const queryExecute = vi.fn(async () => profile());

    const outcome = await customerPages.saveProfile.resolve(
      ctxWith(queryExecute as never, commandExecute as never),
      parse({ birthday: '1990-01-01' }),
    );

    expect(outcome).toMatchObject({ kind: 'view', view: { error: '生日已經設定過，不能修改' } });
  });

  it('未預期的錯誤（5xx）時顯示通用訊息，不外洩內部細節', async () => {
    const commandExecute = vi.fn(async () => { throw new Error('db down'); });
    const queryExecute = vi.fn(async () => profile());

    const outcome = await customerPages.saveProfile.resolve(
      ctxWith(queryExecute as never, commandExecute as never),
      parse({ displayName: '林小明' }),
    );

    expect(outcome).toMatchObject({ kind: 'view', view: { error: '儲存失敗，請稍後再試。' } });
  });
});
