---
description: 用記憶體測試寫出第一個 Extension，接住文章發布事件並驗證安全重播。
pageClass: architecture-page
---

# 實作練習：接住文章發布事件

你已經在[部落格教學](build-a-blog.md)發布過文章。這次親手寫一個小 Extension：收到生活誌文章的發布事件後，在自己的儲存空間留下收據。先把一個 handler 寫對，再考慮寄信或串接外部服務。

這是**可獨立執行的 SDK 單元測試**。不需要啟動 Docker、取得 API token 或連資料庫；上一課的網站可以保持停止。練習完成也不會讓網站自動安裝這個 Extension。

## 1. 先說清楚你要驗證的行為

Content 發布文章時使用的事件名稱是 `commerce.content.article.published.v1`。雖然名稱保留 `commerce`，這個事件來自 Base 也使用的 Content 模組。它的 payload 包含 `articleId`、`kind`、`slug` 與 `occurredAt`，沒有文章全文。

本課的規則只有三項：

- `kind === 'journal'`：以 `event.id` 作為收據鍵，記錄文章與處理時間。
- `kind === 'news'`：忽略，不留收據。
- 同一個 `event.id` 再送一次：保留第一份收據，不改寫處理時間。

這裡去重的是**事件**。同一篇文章若下架後重新發布，產生不同的事件 ID，就可以有另一份收據。不要把 `articleId` 當成「這次投遞」的識別。

依據：[發布 Command](../../packages/platform/content/src/commands.ts)、[事件 schema](../../packages/platform/content/src/events.ts)、[DomainEvent envelope](../../packages/platform/contracts/src/events.ts)。本課會手動建立符合 schema 的事件，直接呼叫 handler；不會真的執行發布 Command。

## 2. 建立一個完整的測試檔

主機需有 Node.js 22 以上與專案釘選的 `pnpm@12.0.0`。在倉庫根目錄執行 `pnpm install` 安裝現有依賴，不需要加入新套件。

新增 `tests/unit/blog-publication-learning.test.ts`，貼上以下完整內容。若已有同名檔案，先保留你的版本，另取一個以 `.test.ts` 結尾的名稱，並同步修改下一步的執行路徑。

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type DomainEvent } from '@storeweave/contracts';
import { articlePublishedV1 } from '@storeweave/content';
import {
  assertExtensionContract,
  createTestExtensionContext,
  defineExtension,
  runExtensionContractChecks,
  type ExtensionEventHandler,
} from '@storeweave/extension-sdk';

type PublishedPayload = z.infer<typeof articlePublishedV1.payload>;
type Receipt = {
  eventId: string;
  articleId: string;
  slug: string;
  recordedAt: string;
};

const receiptKey = (eventId: string) => `publication:${eventId}`;

const observePublication: ExtensionEventHandler<PublishedPayload> = async (event, ctx) => {
  const article = articlePublishedV1.payload.parse(event.payload);
  if (article.kind !== 'journal') return;

  await ctx.store.mutate<Receipt>(receiptKey(event.id), current => current ?? {
    eventId: event.id,
    articleId: article.articleId,
    slug: article.slug,
    recordedAt: ctx.now().toISOString(),
  });
};

const publicationLearning = defineExtension({
  manifest: {
    id: 'blog-publication-learning',
    name: 'Blog publication learning',
    version: '0.1.0',
    platformVersion: '^1.0.0',
    configuration: z.object({}).strict(),
    permissions: [],
    subscribedEvents: [articlePublishedV1.name],
    registeredCommands: [],
    registeredQueries: [],
    registeredJobs: [],
    registeredProviders: [],
  },
  setup() {
    return {
      events: [{ event: articlePublishedV1.name, handler: observePublication }],
    };
  },
});

function publication(kind: 'journal' | 'news'): DomainEvent<PublishedPayload> {
  const occurredAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: articlePublishedV1.name,
    version: articlePublishedV1.version,
    occurredAt,
    actorId: 'user:learning-editor',
    correlationId: 'learning-publication',
    payload: articlePublishedV1.payload.parse({
      articleId: '00000000-0000-4000-8000-000000000002',
      kind,
      slug: 'hello-blog',
      occurredAt,
    }),
  };
}

async function harness() {
  let clock = new Date('2026-01-01T00:00:01.000Z');
  const ctx = createTestExtensionContext({
    extensionId: publicationLearning.manifest.id,
    extensionVersion: publicationLearning.manifest.version,
    config: {},
    declaredSecrets: [],
    now: () => new Date(clock),
  });
  const registration = await publicationLearning.setup(ctx);
  const subscription = registration.events?.find(item => item.event === articlePublishedV1.name);
  if (!subscription) throw new Error('Missing article publication subscription');
  return {
    ctx,
    deliver: (event: DomainEvent<PublishedPayload>) => subscription.handler(event, ctx),
    advanceClock: () => { clock = new Date('2026-01-01T00:10:00.000Z'); },
  };
}

describe('blog publication learning', () => {
  it('satisfies the SDK registration contract', async () => {
    const checks = await runExtensionContractChecks(publicationLearning, {
      knownEvents: [articlePublishedV1.name],
      knownPermissions: [],
      sampleConfig: {},
      invalidConfig: { unexpected: true },
    });
    assertExtensionContract(checks);
  });

  it('records a journal publication', async () => {
    const { ctx, deliver } = await harness();
    const event = publication('journal');
    await deliver(event);
    expect(await ctx.store.get<Receipt>(receiptKey(event.id))).toEqual({
      eventId: event.id,
      articleId: event.payload.articleId,
      slug: 'hello-blog',
      recordedAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('ignores a news publication', async () => {
    const { ctx, deliver } = await harness();
    await deliver(publication('news'));
    expect(await ctx.store.list('publication:')).toEqual([]);
  });

  it('keeps the first receipt when the same event is replayed', async () => {
    const { ctx, deliver, advanceClock } = await harness();
    const event = publication('journal');
    await deliver(event);
    const firstReceipt = await ctx.store.get<Receipt>(receiptKey(event.id));
    advanceClock();
    await deliver(event);
    expect(await ctx.store.get<Receipt>(receiptKey(event.id))).toEqual(firstReceipt);
    expect(await ctx.store.list('publication:')).toHaveLength(1);
  });
});
```

## 3. 執行，然後讀懂結果

在倉庫根目錄執行：

```bash
pnpm exec vitest run --project unit tests/unit/blog-publication-learning.test.ts
```

**預期結果：** 一個測試檔通過，四個測試通過。這不是整個專案的驗收；它只驗證你剛寫的 SDK 契約與 handler 行為。

先沿著程式走一次：

1. `defineExtension` 驗證 manifest 的基本形狀。`subscribedEvents` 說明你想接哪些事件。
2. `setup` 回傳真正的訂閱宣告。契約測試檢查它與 manifest 一致，也檢查設定 schema 與版本相容性。
3. `harness` 建立記憶體 Context，從 `setup` 的回傳值取出 handler。`deliver` 是本課寫的測試輔助函式，不是正式 SDK 的事件投遞 API。
4. handler 解析 payload，先排除非 journal，再透過 `ctx.store.mutate` 建立收據。已有收據時回傳原值，因此重播保留第一次的時間。

Extension 只拿自己的 Context；本例沒有取得 Content 資料表、資料庫連線或交易物件。`permissions: []` 是因為它沒有呼叫其他模組的 Command／Query，也沒有寄信。自己的 `ctx.store` 不需要假造一個 Content 寫入權限。

`mutate` 的 SDK 契約是單一交易內的讀改寫，記憶體替身也序列化同鍵操作。但本課測的是循序重播，並沒有驗證正式資料庫的交易或併發行為。收據也不代表外部同步成功；這裡根本沒有外部呼叫。

依據：[Extension registration](../../packages/platform/extension-sdk/src/registration.ts)、[Context 邊界](../../packages/platform/extension-sdk/src/context.ts)、[Store 契約](../../packages/platform/extension-sdk/src/store.ts)、[測試替身](../../packages/platform/extension-sdk/src/testing.ts)、[契約檢查](../../packages/platform/extension-sdk/src/contract-test.ts)。

## 4. 改一行，觀察測試抓到什麼

先把 `current => current ?? {` 改成 `current => ({`，並把該回呼末尾的 `});` 改成 `}));`，讓每次投遞都重建收據。再次執行同一條 Vitest 命令。

**預測結果：** 前三項仍通過，重播測試失敗。收據仍只有一筆，但 `recordedAt` 已從 `00:00:01` 改成 `00:10:00`。這解釋了為什麼只測筆數不足以證明重播沒有改變結果。觀察完，把這兩處改回原本內容，再確認四項全綠。

接著可自行加第五項測試：複製 journal 事件、換成另一個有效 UUID 的 `id`，投遞後應有兩份收據，即使 `articleId` 相同。你正在驗證「每個事件留一份」，而非「每篇文章永遠只能處理一次」。

## 這個 Extension 現在安裝在哪裡？

目前只存在你建立的測試檔。`createTestExtensionContext` 的 Store 在行程結束後就消失。**本課沒有驗證網站安裝、Outbox fan-out、Worker 投遞、跨行程持久化、重試或外部副作用。**

不要把 `blog-publication-learning` 加到上一課的 Base YAML 就期待啟用。現有 Base Release 固定選取空的 Extension 集合，並以 exact selection 驗證；真正產品化需要有自己的 Release 組裝、可用 Extension 清單與建置驗證。相關限制見 [Base Release definition](../../packages/releases/base/src/definition.ts)。

回到[從 Blog 延伸自己的功能](extending-a-feature.md)，決定下一個需求應由 Theme、模組還是 Extension 負責。要處理真實外部同步，再沿[Extension 開發指南](../extension-development.md)加入背景工作、外部冪等鍵與整合測試；本課的記憶體收據不能替代那些保證。

若只想做一次練習，可刪除你剛新增的 `tests/unit/blog-publication-learning.test.ts`；若保留為正式變更，除了此處的 focused test，仍需通過專案完成門檻 `make verify`。
