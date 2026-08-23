import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { noopLogger } from '@storeweave/contracts';
import { AVAILABLE_EXTENSIONS, coreModules } from '@storeweave/bundle';

/**
 * 舊版訂單事件還有沒有人訂閱（工單 24）。
 *
 * 這是一份會過期的事實：工單 24 的前置條件是「沒有訂閱者」，而那個盤點寫在文件裡，
 * 沒有東西攔得住有人明天加一個回去。掃的是 EventBus 實際的兩個註冊來源——
 * `coreModules()` 的 subscribers 與每一份 manifest 的 subscribedEvents，
 * 與 `runtime.ts`、`extension-host.ts` 走的是同一條路。
 *
 * 這條測試紅了不代表誰做錯事：它代表工單 24 的前置條件變了，那份盤點要重做。
 */
const LEGACY_ORDER_EVENTS = [
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

describe('舊版訂單事件的訂閱者（工單 24）', () => {
  it('掃得到訂閱——掃不到東西的測試會永遠是綠的', () => {
    const all = registeredSubscriptions();
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((s) => s.event)).toContain('commerce.order.paid.v2');
  });

  it('沒有任何訂閱者停在 placed.v1 / placed.v2 / paid.v1', () => {
    const legacy = registeredSubscriptions().filter((s) => LEGACY_ORDER_EVENTS.includes(s.event));
    expect(legacy).toEqual([]);
  });
});
