# Extension 開發

Extension 是客戶特殊需求的唯一落腳處。它只能透過 `@storeweave/extension-sdk` 接入平台 ——
拿不到資料庫、拿不到交易、也碰不到其他模組或其他 Extension 的資料。

## SDK 的十項契約

| # | 契約 | 型別／檔案 |
| --- | --- | --- |
| 1 | Extension Manifest | `ExtensionManifest`（`manifest.ts`） |
| 2 | Provider Contract | `PaymentProvider` / `ShippingProvider` / `ErpProvider`（`providers.ts`） |
| 3 | Command Registry | `ExtensionRegistration.commands`（`ext.<id>.*`） |
| 4 | Query Registry | `ExtensionRegistration.queries`（`ext.<id>.*`） |
| — | 輸入契約 | Command / Query 的 `input` 一律 `.strict()`（ADR 0024，見下） |
| 5 | Domain Event Subscription | `ExtensionRegistration.events` |
| 6 | Policy Registry | `ExtensionRegistration.policies`（deny-overrides） |
| 7 | Permission Declaration | `manifest.permissions` / `manifest.declaredPermissions` |
| 8 | Configuration Schema | `manifest.configuration`（Zod） |
| 9 | Platform Version Compatibility | `manifest.platformVersion`（semver range） |
| 10 | Extension Contract Test 工具 | `runExtensionContractChecks()` / `createTestExtensionContext()` |

## Manifest

```ts
manifest: {
  id: 'demo-erp',                       // ^[a-z][a-z0-9-]{2,63}$
  name: 'Demo ERP Integration',
  version: '1.0.0',                     // semver
  platformVersion: '^1.0.0',            // 相容的平台版本範圍
  permissions: ['order:read', 'erp:read', 'erp:write'],
  declaredPermissions: [                // 這個 Extension 新增的權限鍵
    { key: 'erp:read',  description: '讀取 ERP 投遞狀態' },
    { key: 'erp:write', description: '重送訂單到 ERP' },
  ],
  requiredSecrets: ['DEMO_ERP_API_KEY'],// 只放名稱；值永遠來自環境變數或 Secret Provider
  configuration: demoErpConfig,         // Zod schema
  subscribedEvents: ['commerce.order.paid.v2'],
  registeredCommands: ['ext.demo-erp.resendOrder'],
  registeredQueries:  ['ext.demo-erp.listDeliveries'],
  registeredProviders: [{ kind: 'erp', id: 'demo-erp', isDefault: true }],
}
```

Manifest 是**宣告**，`setup()` 是**實作**，兩者必須完全一致。掛載時 `ExtensionHost`
會逐項比對，宣告了沒註冊、或註冊了沒宣告，都會在啟動時直接失敗，不會等到執行期。

## ExtensionContext：Extension 唯一的執行環境

```ts
ctx.config                    // 已通過 configuration schema 驗證的設定
ctx.logger                    // 結構化 log，欄位會先經過機密遮蔽
ctx.commands.execute(name, input, { idempotencyKey })   // 只能用 manifest 宣告過的權限
ctx.queries.execute(name, input)
ctx.jobs.enqueue({ type, payload, dedupeKey, runAt, maxAttempts })  // type 必須是 ext.<id>.*
ctx.jobs.requeue(jobId)       // 人工重送
ctx.store                     // 以 extension id 隔離的 get/set/delete/list/mutate
ctx.getProvider('erp')        // 只拿得到宣告過的 provider kind
ctx.secret('DEMO_ERP_API_KEY')// 只讀得到 requiredSecrets 列出的名稱
ctx.now()
```

刻意沒有的東西：`tx`、`db`、連線池、其他模組的 repository、對全域 registry 的寫入權。

## 完整範例：加價購 Extension

以下是一個真實可用的最小 Extension，示範全部十項契約中的六項。

`packages/extensions/gift-wrap/src/index.ts`

```ts
import { z } from 'zod';
import { defineCommand, defineQuery } from '@storeweave/contracts';
import { defineExtension, defineMcpTool } from '@storeweave/extension-sdk';

const config = z.object({
  feeCents: z.number().int().min(0).default(5000),
  // 超過這個金額免費包裝；0 代表不啟用
  freeAboveCents: z.number().int().min(0).default(0),
  blockedCountries: z.array(z.string().length(2)).default([]),
});
type Config = z.infer<typeof config>;

const requestWrapCommand = defineCommand({
  name: 'ext.gift-wrap.requestWrap',
  summary: '為訂單加購禮品包裝',
  // 輸入一律 `.strict()`（ADR 0024）：Zod 預設會安靜丟掉未知欄位，端點回 200 而什麼都沒做。
  input: z.object({ orderId: z.string().uuid(), message: z.string().max(200).optional() }).strict(),
  output: z.object({ orderId: z.string(), feeCents: z.number().int(), status: z.string() }),
  permission: 'gift-wrap:write',
  idempotency: 'required',
  audit: { action: 'gift-wrap.requested', resourceType: 'order', resourceId: (i) => i.orderId },
});

const listWrapsQuery = defineQuery({
  name: 'ext.gift-wrap.listWraps',
  summary: '列出已加購包裝的訂單',
  input: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(),
  output: z.object({ items: z.array(z.object({
    orderId: z.string(), feeCents: z.number().int(), message: z.string().nullable(), status: z.string(),
  })) }),
  permission: 'gift-wrap:read',
});

export const giftWrapExtension = defineExtension<Config>({
  manifest: {
    id: 'gift-wrap',
    name: 'Gift Wrap',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    permissions: ['order:read', 'gift-wrap:read', 'gift-wrap:write'],
    declaredPermissions: [
      { key: 'gift-wrap:read', description: '讀取禮品包裝加購紀錄' },
      { key: 'gift-wrap:write', description: '新增禮品包裝加購' },
    ],
    configuration: config,
    subscribedEvents: ['commerce.order.paid.v2'],
    registeredCommands: [requestWrapCommand.name],
    registeredQueries: [listWrapsQuery.name],
    registeredProviders: [],
  },

  setup(ctx) {
    return {
      // 3. Command Registry —— handler 收到的是 ExtensionContext，沒有 tx
      commands: [{
        descriptor: requestWrapCommand,
        handler: async (input, invocationCtx) => {
          // 讀訂單只能走 Query Bus，不能查表
          const order = await invocationCtx.queries.execute<{ totalCents: number; status: string }>(
            'commerce.order.getOrder', { id: input.orderId },
          );
          const free = ctx.config.freeAboveCents > 0 && order.totalCents >= ctx.config.freeAboveCents;
          const feeCents = free ? 0 : ctx.config.feeCents;

          await ctx.store.set(`wrap:${input.orderId}`, {
            orderId: input.orderId, feeCents, message: input.message ?? null, status: 'requested',
          });
          return { orderId: input.orderId, feeCents, status: 'requested' };
        },
      }],

      // 4. Query Registry
      queries: [{
        descriptor: listWrapsQuery,
        handler: async (input) => ({
          items: (await ctx.store.list<any>('wrap:', input.limit)).map((e) => e.value),
        }),
      }],

      // 5. Domain Event Subscription —— 只記錄與排工作，外部呼叫留給背景工作
      events: [{
        event: 'commerce.order.paid.v2',
        maxAttempts: 8,
        handler: async (event) => {
          const payload = event.payload as { orderId: string };
          const wrap = await ctx.store.get<any>(`wrap:${payload.orderId}`);
          if (!wrap || wrap.status !== 'requested') return;
          await ctx.jobs.enqueue({
            type: 'ext.gift-wrap.prepare',
            payload: { orderId: payload.orderId },
            dedupeKey: `ext.gift-wrap:prepare:${payload.orderId}`, // 保證只做一次
          });
        },
      }],

      jobs: [{
        type: 'ext.gift-wrap.prepare',
        handler: async (payload) => {
          const { orderId } = payload as { orderId: string };
          const wrap = await ctx.store.get<any>(`wrap:${orderId}`);
          if (!wrap || wrap.status === 'prepared') return;      // 冪等
          await ctx.store.set(`wrap:${orderId}`, { ...wrap, status: 'prepared' });
          ctx.logger.info({ orderId }, 'gift wrap prepared');
        },
      }],

      // 6. Policy Registry —— 只能否決，不能給出沒有的權限
      policies: [{
        id: 'gift-wrap.blocked-countries',
        appliesTo: ['gift-wrap:write'],
        owner: 'gift-wrap',
        reason: '這個國家不提供禮品包裝',
        evaluate: ({ resource }) => {
          const country = resource?.attributes?.country as string | undefined;
          return country && ctx.config.blockedCountries.includes(country) ? 'deny' : 'abstain';
        },
      }],

      // MCP 工具：只能指向已註冊的 Command 或 Query
      mcpTools: [defineMcpTool({
        name: 'request_gift_wrap',
        description: '為指定訂單加購禮品包裝。',
        input: z.object({
          orderId: z.string().uuid(),
          message: z.string().max(200).optional(),
          idempotencyKey: z.string().min(8),
        }),
        target: { kind: 'command', name: requestWrapCommand.name },
        requiresIdempotencyKey: true,
        mapInput: (i) => ({ orderId: i.orderId, message: i.message }),
      })],
    };
  },

  async healthCheck(ctx) {
    const items = await ctx.store.list('wrap:', 200);
    return { ok: true, message: `${items.length} wraps recorded, fee=${ctx.config.feeCents}` };
  },
});

export default giftWrapExtension;
```

## 輸入一律 `.strict()`

Command 與 Query 的 `input` 都必須拒絕未知欄位（ADR 0024）。Zod 的 `z.object()` 預設會**丟掉**
不認得的鍵：端點回 200、handler 收到的物件裡沒有那個鍵，送出者以為自己設到了東西。
Contract Test 的 `command / query inputs reject unknown keys` 會擋下漏寫的那一支。

`input` 還必須是**一個平的 object**，不能是 union、array 或 intersection：
`GET /api/v1/extensions/<id>/queries/<name>` 的橋接依 `declaredInputKeys()` 讀出你宣告了哪些鍵，
只把那些鍵往下送——`?_t=` 這類 cache-buster 才不會撞上 `.strict()` 回 400。剝不出鍵的輸入
由 `command / query inputs are a plain object the HTTP bridge can pick keys from` 擋下。
Command 的 JSON body 不做這個過濾：那裡多出來的鍵一定是呼叫端自己送的，就該回 400。

## Contract Test

在不啟動平台、不連資料庫的情況下驗證契約：

```ts
import { describe, expect, it } from 'vitest';
import { runExtensionContractChecks } from '@storeweave/extension-sdk';
import { knownEventNames, knownPermissionKeys } from '@storeweave/bundle';
import { giftWrapExtension } from '@storeweave/ext-gift-wrap';

describe('gift-wrap 契約', () => {
  it('符合 Extension SDK 契約', async () => {
    const checks = await runExtensionContractChecks(giftWrapExtension, {
      knownEvents: knownEventNames(),
      knownPermissions: knownPermissionKeys(),
      sampleConfig: { feeCents: 5000 },
      invalidConfig: { feeCents: -1 },
    });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
```

檢查項目包含：manifest 結構、平台版本相容性、訂閱的事件是否存在、請求的權限是否已知、
設定 schema 是否可用且真的會擋掉錯誤設定、`setup()` 是否有副作用、
manifest 宣告與實際註冊是否一致、命名空間是否正確、job type 是否重複。

用 `createTestExtensionContext()` 可以進一步做行為測試：它提供記憶體版 Store、
Command/Query stub、以及 `drainJobs()` 讓你在測試裡走完整條背景工作流程
（範例見 `packages/extensions/demo-erp/test/delivery.test.ts`）。

## 掛進 Release

1. 建立 `packages/extensions/<id>/`（package.json + src）。
2. 在 `tsconfig.base.json` 的 `paths` 加上別名。
3. 在 `packages/platform/bundle/src/modules.ts` 的 `AVAILABLE_EXTENSIONS` 註冊。
4. 在該店的 `commerce.yaml` 啟用：

```yaml
extensions:
  - id: gift-wrap
    enabled: true
    config:
      feeCents: 5000
      freeAboveCents: 200000
      blockedCountries: [JP]
```

5. `pnpm build` 或 `pnpm build:release`。

啟用一個不在 Release 裡的 id 會在啟動時直接失敗並列出可用清單 —— 不會沉默地少掛一個功能。

## 常見錯誤

| 症狀 | 原因 |
| --- | --- |
| `Extension "x" commands mismatch` | manifest 宣告與 `setup()` 註冊不一致 |
| `may only register commands under "ext.x."` | 命名空間錯誤 |
| `Forbidden: missing permission ...` | 呼叫了 manifest 沒宣告權限的 Command |
| `must declare secret "X" in requiredSecrets` | 讀取未宣告的機密 |
| `requires secret "X" which is not set` | 環境變數或 Secret Provider 沒有提供該機密 |
| `is incompatible: extension requires platform ^1.0.0` | `platformVersion` 與目前平台版本不符 |
| `did not declare access to payment providers` | 取用未宣告的 provider kind |
| `command / query inputs reject unknown keys` | 有一支 `input` 漏了 `.strict()`（ADR 0024） |
| `... are a plain object the HTTP bridge can pick keys from` | `input` 不是平的 object（union / array），橋接讀不出它宣告了哪些鍵 |
