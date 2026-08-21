import { describe, expect, it } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import {
  createMockNotificationProvider,
  listSentNotifications,
  mockNotificationConfig,
  type MockNotificationConfig,
} from '@storeweave/ext-mock-notification';

function context(overrides: Partial<MockNotificationConfig> = {}) {
  return createTestExtensionContext<MockNotificationConfig>({
    extensionId: 'mock-notification',
    config: mockNotificationConfig.parse(overrides),
    now: () => new Date('2026-08-22T10:00:00.000Z'),
  });
}

const message = {
  template: 'customer.password-reset',
  to: { email: 'buyer@example.com', name: '買家' },
  variables: { resetUrl: 'https://shop.example/reset?token=abc' },
  reference: 'password-reset:1',
};

describe('mock notification provider', () => {
  it('寄出的內容留得下來供測試斷言', async () => {
    const ctx = context();
    const provider = createMockNotificationProvider(ctx);

    const result = await provider.send(message);

    expect(result.status).toBe('sent');
    const sent = await listSentNotifications(ctx.store);
    expect(sent).toEqual([
      {
        reference: 'password-reset:1',
        template: 'customer.password-reset',
        to: { email: 'buyer@example.com', name: '買家' },
        variables: { resetUrl: 'https://shop.example/reset?token=abc' },
        locale: null,
        providerRef: result.providerRef,
        sentAt: '2026-08-22T10:00:00.000Z',
      },
    ]);
  });

  it('同一個 reference 重送只留一封，回傳同一個 providerRef', async () => {
    const ctx = context();
    const provider = createMockNotificationProvider(ctx);

    const first = await provider.send(message);
    const second = await provider.send(message);

    expect(second.providerRef).toBe(first.providerRef);
    expect(second.message).toBe('replayed');
    expect(await listSentNotifications(ctx.store)).toHaveLength(1);
  });

  it('關掉投遞時回報失敗，而且不留紀錄——失敗允許之後重試', async () => {
    const ctx = context({ deliver: false });
    const provider = createMockNotificationProvider(ctx);

    const result = await provider.send(message);

    expect(result.status).toBe('failed');
    expect(await listSentNotifications(ctx.store)).toEqual([]);
  });

  it('是 notification 種類的 Provider，且有健康檢查', async () => {
    const provider = createMockNotificationProvider(context());
    expect(provider.kind).toBe('notification');
    expect((await provider.healthCheck!()).ok).toBe(true);
  });

  it('寄出時間來自平台提供的時鐘，不是自己讀 Date.now', async () => {
    const ctx = createTestExtensionContext<MockNotificationConfig>({
      extensionId: 'mock-notification',
      config: mockNotificationConfig.parse({}),
      now: () => new Date('2001-01-01T00:00:00.000Z'),
    });

    await createMockNotificationProvider(ctx).send(message);

    expect((await listSentNotifications(ctx.store))[0].sentAt).toBe('2001-01-01T00:00:00.000Z');
  });
});
