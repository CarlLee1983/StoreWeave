import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runExtensionContractChecks, type ContractCheck } from '@storeweave/extension-sdk';
import { AVAILABLE_EXTENSIONS, knownEventNames, knownPermissionKeys } from '@storeweave/bundle';

const knownEvents = knownEventNames();
const knownPermissions = knownPermissionKeys();

function report(checks: ContractCheck[]) {
  return checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.message ?? ''}`);
}

describe('Extension Contract Test', () => {
  it('reports jobs absent from the static manifest', async () => {
    const extension = AVAILABLE_EXTENSIONS['demo-erp'];
    const checks = await runExtensionContractChecks({
      ...extension, manifest: { ...extension.manifest, registeredJobs: [] },
    }, { secrets: { DEMO_ERP_API_KEY: 'test-key' } });
    expect(checks.find(check => check.name === 'registered jobs match the manifest')?.ok).toBe(false);
  });

  it.each(Object.keys(AVAILABLE_EXTENSIONS))('%s 符合 Extension SDK 契約', async (id) => {
    const sampleConfig = id === 'ecpay'
      ? {
        returnUrl: 'https://shop.example.test/callbacks/payment/ecpay',
        paymentInfoUrl: 'https://shop.example.test/callbacks/payment/ecpay',
      }
      : id === 'ecpay-logistics'
        ? { mode: 'fake' }
        : {};
    const checks = await runExtensionContractChecks(AVAILABLE_EXTENSIONS[id], {
      knownEvents,
      knownPermissions,
      sampleConfig,
      secrets: {
        DEMO_ERP_API_KEY: 'test-key',
        ECPAY_MERCHANT_ID: 'test-merchant-id',
        ECPAY_HASH_KEY: 'test-hash-key',
        ECPAY_HASH_IV: 'test-hash-iv',
        ECPAY_LOGISTICS_MERCHANT_ID: 'test-logistics-merchant-id',
        ECPAY_LOGISTICS_HASH_KEY: 'test-logistics-hash-key',
        ECPAY_LOGISTICS_HASH_IV: 'test-logistics-hash-iv',
        ECPAY_INVOICE_MERCHANT_ID: '2000132',
        ECPAY_INVOICE_HASH_KEY: '1234567890123456',
        ECPAY_INVOICE_HASH_IV: '1234567890123456',
      },
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

  /** 把某支 extension 註冊的每一支 query 換成指定的輸入 schema，其餘照舊。 */
  function withQueryInput(base: (typeof AVAILABLE_EXTENSIONS)[string], input: z.ZodTypeAny) {
    return {
      ...base,
      async setup(ctx: any) {
        const registration = await base.setup(ctx);
        const queries = registration.queries ?? [];
        // 一支 query 都沒有的話這個測試什麼都沒驗到——要一個看得懂的失敗。
        expect(queries.length).toBeGreaterThan(0);
        return { ...registration, queries: queries.map((q) => ({ ...q, descriptor: { ...q.descriptor, input } })) };
      },
    } as typeof base;
  }

  it('輸入放行未知欄位時會失敗——這條檢查對每一支 extension 都成立（工單 51）', async () => {
    // `.strict()` 拿掉：Zod 預設會安靜丟掉未知欄位，這正是 ADR 0024 要擋的行為。
    const lax = withQueryInput(AVAILABLE_EXTENSIONS['demo-erp'], z.object({ orderId: z.string().uuid() }));

    const checks = await runExtensionContractChecks(lax, {
      sampleConfig: {}, secrets: { DEMO_ERP_API_KEY: 'test-key' },
      providers: { erp: { id: 'demo-erp', kind: 'erp', push: async () => ({ accepted: true, remoteId: 'x' }) } as any },
    });
    const check = checks.find((c) => c.name === 'command / query inputs reject unknown keys')!;
    expect(check.ok).toBe(false);
    expect(check.message).toContain('ext.demo-erp.listDeliveries');
  });

  it('嚴格但橋接剝不出鍵的輸入（union）也會失敗——否則 cache-buster 又會回 400（工單 51）', async () => {
    const base = AVAILABLE_EXTENSIONS['demo-erp'];
    const union = z.union([
      z.object({ orderId: z.string().uuid() }).strict(),
      z.object({ reference: z.string() }).strict(),
    ]);
    // union 每一支分支都 `.strict()`，嚴格性沒有問題（它連 unrecognized_keys 都不吐，
    // 頂層是 invalid_union）——守得住這種輸入的只有「橋接讀得出它宣告了哪些鍵」那一項。

    const checks = await runExtensionContractChecks(withQueryInput(base, union), {
      sampleConfig: {}, secrets: { DEMO_ERP_API_KEY: 'test-key' },
      providers: { erp: { id: 'demo-erp', kind: 'erp', push: async () => ({ accepted: true, remoteId: 'x' }) } as any },
    });

    expect(checks.find((c) => c.name === 'command / query inputs reject unknown keys')?.ok).toBe(true);
    const pickable = checks.find((c) => c.name === 'command / query inputs are a plain object the HTTP bridge can pick keys from')!;
    expect(pickable.ok).toBe(false);
    expect(pickable.message).toContain('ext.demo-erp.listDeliveries');
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
      'commerce.content.article.published.v1',
      'commerce.content.contact.submitted.v1',
      'commerce.customer.registered.v1',
      'commerce.inventory.adjusted.v1',
      'commerce.order.cancelled.v1',
      'commerce.order.paid.v2',
      'commerce.order.paymentInfoIssued.v1',
      'commerce.order.placed.v3',
      'commerce.product.created.v1',
      'commerce.product.updated.v1',
    'commerce.refund.failed.v1',
    'commerce.refund.requested.v1',
    'commerce.refund.succeeded.v1',
    'commerce.rma.changed.v1',
    'commerce.rma.requested.v1',
    'commerce.shipment.arrived.v1',
      'commerce.shipment.completed.v1',
      'commerce.shipment.created.v1',
      'commerce.shipment.shipped.v1',
    ]);
  });

  it('demo-erp 只訂閱平台已知的事件', () => {
    for (const name of AVAILABLE_EXTENSIONS['demo-erp'].manifest.subscribedEvents) {
      expect(knownEvents).toContain(name);
    }
  });
});
