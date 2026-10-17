---
description: 按建立檔案的順序，寫出 Notes 的輸入契約、資料表、讀寫規則與模組宣告。
pageClass: architecture-page
---

# 第二課：寫出第一個模組

這一課先完成最小的資料流程：**接收標題與本文，建立屬於目前作者的草稿，再讀回自己的筆記。** 頁面和啟動環境留到下一課；這裡先讓每一個欄位與規則有明確的擁有者。

範例放在 [`packages/examples/notes`](../../../packages/examples/notes/)。倉庫已包含完整版本，以下按照新建時的順序拆解。你可以在自己的練習分支逐段打出後與完整檔案比較；已有檔案直接閱讀即可，無須再建立第二個同名模組。文中的短程式碼是局部摘錄，完整的 import、型別與註冊以各檔案連結為準。

## 1. 先把需求寫成輸入和輸出

先建立 `src/types.ts`。畫面只讓作者填標題與本文；筆記 id、擁有者、初始狀態和時間由伺服器決定。

```ts
export const noteFields = {
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(10000),
};
export const createNoteInput = z.object(noteFields).strict();
```

Zod schema 把輸入限制變成可執行的程式。`trim()` 先去除前後空白，`min(1)` 拒絕空白內容，`strict()` 拒絕未宣告欄位。例如自行送入 `ownerActorId`，不會因此改變資料擁有者。

同一檔案的 `noteDto` 定義回傳形狀，包含 `id`、`title`、`body`、`status`、`revision` 與時間。資料庫需要保存作者，但公開頁面不需要取得作者識別碼，所以 DTO 沒有 `ownerActorId`。

完整檔案：[types.ts](../../../packages/examples/notes/src/types.ts)。先確認你能分清「呼叫者可以填的欄位」和「系統回傳的欄位」，再往下走。

## 2. 保存這些欄位：schema 與 migration 各寫一份

`src/schema.ts` 用 Drizzle 描述 TypeScript 存取的資料表。核心欄位如下：

```ts
export const notes = pgTable('notes_entries', {
  id: uuid('id').primaryKey(),
  ownerActorId: text('owner_actor_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<'draft' | 'published'>().notNull(),
  revision: integer('revision').notNull(),
  // createdAt、updatedAt 見完整檔案。
});
```

`src/migrations.ts` 則提供實際建立 `notes_entries` 的 SQL。範例的 migration owner 是 `notes`，第一筆 id 是 `0001_init`，phase 是 `expand`。SQL 也限制 `status` 只能是 `draft`／`published`，`revision` 必須大於零，並建立作者和公開列表使用的索引。

Drizzle 宣告不會自動把表建進資料庫；Release 啟動流程會使用已註冊的 migration。兩邊的表名與欄位要一致。已交付的 migration 內容要保留，之後改結構時新增下一筆 migration。

完整檔案：[schema.ts](../../../packages/examples/notes/src/schema.ts)、[migrations.ts](../../../packages/examples/notes/src/migrations.ts)。

## 3. 讓 repository 只碰自己的表

`src/repository.ts` 集中 Notes 的資料存取。建立筆記時，它使用呼叫端傳入的交易，寫入後把資料轉成 DTO：

```ts
async insert(tx: Tx, row: typeof notes.$inferInsert): Promise<Note> {
  const [saved] = await tx.insert(notes).values(row).returning();
  return toNote(saved!);
}
```

`toNote()` 去掉 `ownerActorId`，讓資料庫內部欄位不會順著回傳值流到前台。其餘方法也只操作 `notes_entries`；帳號與 Session 的資料由平台認證能力管理。

先寫出 `insert()` 和 `owned()` 就能理解第一條建立／讀回路徑。更新與公開閱讀需要更多條件，第四課會逐一驗證。

完整檔案：[repository.ts](../../../packages/examples/notes/src/repository.ts)。

## 4. 宣告建立草稿的 Command，再寫 handler

`src/commands.ts` 把「建立筆記」宣告為 `notes.entry.create`。四支寫入共用以下設定：

```ts
const commandOptions = {
  permission: 'notes:write',
  idempotency: 'required',
  idempotencyScope: 'actor',
} as const;
```

Descriptor 用 `createNoteInput` 接收輸入、用 `noteDto` 驗證輸出，並宣告 Audit。Handler 才決定建立的是什麼：

```ts
export async function createNoteHandler(
  input: z.infer<typeof createNoteInput>, ctx: CommandContext,
) {
  return repository.insert(ctx.tx, {
    ...input, id: randomUUID(), ownerActorId: ctx.actor.id,
    status: 'draft', revision: 1,
    createdAt: ctx.now, updatedAt: ctx.now,
  });
}
```

注意三個產品決定：作者來自 `ctx.actor.id`，初始狀態固定為草稿，版本從 `1` 開始。資料透過 `ctx.tx` 寫入 CommandBus 的交易。Handler 不需要自己開連線、解析 cookie 或開始另一筆交易。

`required` 表示正式經 Bus 呼叫時必須提供冪等鍵；`actor` 表示該鍵以操作身分分區。之後的表單會將 `operationId` 轉成執行選項中的 `idempotencyKey`，它不是筆記欄位，也不放進 `createNoteInput`。

完整檔案：[commands.ts](../../../packages/examples/notes/src/commands.ts)。

## 5. 寫出「我的筆記」Query

在 `src/queries.ts`，`notes.entry.getMine` 使用 `notes:write` 權限，輸入只要一個 UUID。Handler 把目前 Actor 傳給 repository：

```ts
export async function getMineHandler(
  input: z.infer<typeof noteIdInput>, ctx: QueryContext,
) {
  const note = await repository.owned(ctx.db, input.id, ctx.actor.id);
  if (!note) throw PlatformError.notFound('Note', input.id);
  return note;
}
```

`owned()` 在 SQL 同時比對筆記 id 和作者。找不到，或筆記屬於別人，都回傳不存在；不能只先查 id，再由畫面決定是否顯示。

列表使用 `notes.entry.listMine`，同樣由 `ctx.actor.id` 限制作者。每頁 20 筆，回傳 `hasMore` 讓頁面決定是否顯示下一頁。公開讀取則是另一組 `listPublished`／`getPublished`，第四課會看其條件。

完整檔案：[queries.ts](../../../packages/examples/notes/src/queries.ts)。

## 6. 在 module.ts 把能力接起來

最後建立 `src/module.ts`。先把資料與 migration 註冊到 `defineModule()`：

```ts
name: 'notes',
version: packageJson.version,
baseVersionRange: '^1.0.0',
dependencies: {
  required: [{ name: 'platform', versionRange: '^0.1.0' }],
},
data: { owns: ['notes_entries'] },
migrations: notesMigrations,
```

接著宣告 `notes:write`、`notes:public-read`，並將每個 descriptor 和 handler 配對：

```ts
commands: [
  { descriptor: createNote, handler: createNoteHandler },
  { descriptor: updateNote, handler: updateNoteHandler },
  { descriptor: publishNote, handler: publishNoteHandler },
  { descriptor: unpublishNote, handler: unpublishNoteHandler },
],
```

同樣註冊四個 Query 與 `notesPages`。沒有註冊的函式即使存在於檔案，也不會成為平台可呼叫的能力。哪些角色取得權限，留給 Release 決定。

這個模組只需要同步讀寫與頁面，沒有宣告 Event 或 Job；發布筆記不會自動寄信或同步到外部服務。等真正需要背景處理時，再從[完整模組範例](../../module-development.md)學習相應接點。[既有 Extension 練習](../extension-lab.md)訂閱的是 Content 的文章事件，不能直接套到 Notes。

完整檔案：[module.ts](../../../packages/examples/notes/src/module.ts)。套件入口與路徑登記亦可對照 [index.ts](../../../packages/examples/notes/src/index.ts)、[package.json](../../../packages/examples/notes/package.json)、[tsconfig.base.json](../../../tsconfig.base.json)；這些工程設定讓工具找到程式，真正把模組放進產品的是下一課的 Release。

## 本課檢查點：真的讓輸入契約拒絕錯誤

在倉庫根目錄、已安裝套件的情況下執行：

```bash
pnpm exec tsx -e 'import { createNoteInput } from "./packages/examples/notes/src/types.ts"; for (const input of [{ title: "第一篇", body: "我的內容" }, { title: "   ", body: "我的內容" }, { title: "第一篇", body: "我的內容", ownerActorId: "someone-else" }]) console.log(createNoteInput.safeParse(input).success);'
```

預期依序得到 `true`、`false`、`false`。試著把第一筆的標題改成前後有空白，再觀察 `safeParse()` 成功結果中的 `data.title`。

這一步只證明輸入 schema 的行為。資料落表、權限與交易仍需經 Bus 和資料庫驗證；相關測試入口是 [contract.test.ts](../../../packages/examples/notes/test/contract.test.ts) 和 [notes-example.test.ts](../../../tests/integration/notes-example.test.ts)，最後一課會分開執行與解讀。

[下一課：接上頁面與 Release →](pages-and-release.md) · [上一課：平台地圖](platform-map.md)
