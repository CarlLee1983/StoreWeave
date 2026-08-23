import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { noopLogger } from '@storeweave/contracts';
import { AVAILABLE_EXTENSIONS, coreModules, knownEventNames } from '@storeweave/bundle';

/**
 * 舊版訂單事件已經下線（工單 24）。
 *
 * 這條測試原本守的是下線的**前置條件**（沒有訂閱者）。下線做完之後它換了工作：
 * 守的是那三個名字不會被加回來——事件目錄裡沒有它們，也沒有人訂閱它們。
 *
 * 兩側查的是不同的失效模式，所以兩個都要驗：目錄那側擋的是「有人把定義加回去」，
 * 訂閱者那側擋的是「有人訂閱了它」。後者不會在啟動時默默通過——`EventBus.subscribe`
 * 對未知事件名當場拋錯——但那是執行期的事，這裡要的是在 CI 就看得見。
 *
 * 最後一條是哨兵：`knownEventNames()` 如果因為任何原因回空陣列，
 * 前面那兩條會全部變成永遠的綠色。
 */
const RETIRED_ORDER_EVENTS = [
  'commerce.order.placed.v1',
  'commerce.order.placed.v2',
  'commerce.order.paid.v1',
];

function registeredSubscriptions(): { subscriber: string; event: string }[] {
  const providers = new ProviderRegistry(noopLogger);
  const modules = coreModules({
    providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW',
  });

  const found: { subscriber: string; event: string }[] = [];
  for (const module of modules) {
    for (const sub of module.subscribers ?? []) found.push({ subscriber: `core:${module.name}`, event: sub.eventName });
  }
  for (const [id, extension] of Object.entries(AVAILABLE_EXTENSIONS)) {
    for (const event of extension.manifest.subscribedEvents) found.push({ subscriber: `ext:${id}`, event });
  }
  return found;
}

describe('舊版訂單事件已經下線（工單 24）', () => {
  it('掃得到訂閱——掃不到東西的測試會永遠是綠的', () => {
    const all = registeredSubscriptions();
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((s) => s.event)).toContain('commerce.order.paid.v2');
  });

  it('事件目錄裡沒有 placed.v1 / placed.v2 / paid.v1', () => {
    expect(knownEventNames().filter((name) => RETIRED_ORDER_EVENTS.includes(name))).toEqual([]);
  });

  it('沒有任何訂閱者停在那三個名字上', () => {
    const legacy = registeredSubscriptions().filter((s) => RETIRED_ORDER_EVENTS.includes(s.event));
    expect(legacy).toEqual([]);
  });

  it('取代它們的那兩個還在——下線不是把整條路拆掉', () => {
    const known = knownEventNames();
    expect(known).toContain('commerce.order.placed.v3');
    expect(known).toContain('commerce.order.paid.v2');
  });
});
