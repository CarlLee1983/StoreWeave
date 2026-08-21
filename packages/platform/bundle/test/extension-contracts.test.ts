import { describe, expect, it } from 'vitest';
import { runExtensionContractChecks, type ContractCheck } from '@storeweave/extension-sdk';
import { AVAILABLE_EXTENSIONS, knownEventNames, knownPermissionKeys } from '@storeweave/bundle';

const knownEvents = knownEventNames();
const knownPermissions = knownPermissionKeys();

function report(checks: ContractCheck[]) {
  return checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.message ?? ''}`);
}

describe('Extension Contract Test', () => {
  it.each(Object.keys(AVAILABLE_EXTENSIONS))('%s 符合 Extension SDK 契約', async (id) => {
    const checks = await runExtensionContractChecks(AVAILABLE_EXTENSIONS[id], {
      knownEvents,
      knownPermissions,
      sampleConfig: {},
      secrets: { DEMO_ERP_API_KEY: 'test-key' },
      providers: {
        erp: { id: 'demo-erp', kind: 'erp', push: async () => ({ accepted: true, remoteId: 'x' }) } as any,
      },
    });
    expect(report(checks)).toEqual([]);
    expect(checks.length).toBeGreaterThan(5);
  });

  it('不相容的 platformVersion 會被抓出來', async () => {
    const checks = await runExtensionContractChecks(AVAILABLE_EXTENSIONS.mcp, { platformVersion: '2.0.0' });
    expect(checks.find((c) => c.name === 'platform version compatible')?.ok).toBe(false);
  });

  it('manifest 與實際註冊不一致時會失敗', async () => {
    const broken = {
      ...AVAILABLE_EXTENSIONS.mcp,
      manifest: { ...AVAILABLE_EXTENSIONS.mcp.manifest, registeredQueries: ['ext.mcp.somethingElse'] },
    };
    const checks = await runExtensionContractChecks(broken, { sampleConfig: {} });
    expect(checks.find((c) => c.name === 'registered queries match the manifest')?.ok).toBe(false);
  });
});

describe('Release bundle', () => {
  it('公開全部版本化的核心事件', () => {
    expect(knownEvents).toEqual([
      'commerce.inventory.adjusted.v1',
      'commerce.order.cancelled.v1',
      'commerce.order.paid.v1',
      'commerce.order.paid.v2',
      'commerce.order.placed.v1',
      'commerce.order.placed.v2',
      'commerce.order.placed.v3',
      'commerce.product.created.v1',
      'commerce.product.updated.v1',
    ]);
  });

  it('demo-erp 只訂閱平台已知的事件', () => {
    for (const name of AVAILABLE_EXTENSIONS['demo-erp'].manifest.subscribedEvents) {
      expect(knownEvents).toContain(name);
    }
  });
});
