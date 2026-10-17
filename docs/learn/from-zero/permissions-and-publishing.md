---
description: 用作者、另一個帳號與匿名訪客，驗證 Notes 的擁有權、版本衝突、冪等與發布邊界。
pageClass: architecture-page
---

# 第四課：加上權限與發布邊界

上一課已把 Notes 跑成網站。現在用同一篇筆記驗證四個承諾：只有作者能管理、草稿不公開、舊畫面不能蓋掉新內容、相同操作重送不會再建立一篇。

準備第三課的獨立練習環境、一個作者帳號 A、另一個帳號 B，以及不帶登入狀態的瀏覽器視窗。帳號建立與登入沿用[第三課](pages-and-release.md)，這一課不改機密或資料庫設定。

## 1. 先分清楚權限與擁有權

模組的 [module.ts](../../../packages/examples/notes/src/module.ts) 宣告兩個權限，Release 的 [runtime.ts](../../../packages/examples/notes/src/runtime.ts) 決定把它們授予哪些角色。

| 權限 | 授予對象 | 可以使用的能力 |
| --- | --- | --- |
| `notes:public-read` | Release 的各角色，包含匿名訪客 | `listPublished`、`getPublished` |
| `notes:write` | `member`、`staff`；`admin` 沿用其萬用權限 | 建立、更新、發布、收回；`listMine`、`getMine` |

拿到 `notes:write` 只代表可以進入管理操作。某筆資料是不是自己的，還要由 handler 和 SQL 檢查。Notes 不提供跨作者管理入口，`admin` 也不跳過擁有權條件。

建立時，作者固定取自 `ctx.actor.id`；後續更新 patch 只接受標題、本文或狀態，因此沒有轉移擁有者的操作。Repository 的 `owned()` 查詢條件是：

```ts
and(eq(notes.id, id), eq(notes.ownerActorId, owner))
```

找不到自己的筆記會回 `NOT_FOUND`，即使另一個作者確實擁有相同 id 的筆記也一樣。依據：[commands.ts](../../../packages/examples/notes/src/commands.ts)、[queries.ts](../../../packages/examples/notes/src/queries.ts)、[repository.ts](../../../packages/examples/notes/src/repository.ts)。

## 2. 把發布做成明確的狀態轉換

這個範例的生命週期只有兩種狀態：

```text
建立 → draft ── publish ──→ published
        ↑                      │
        └──── unpublish ────────┘
```

| 操作 | 目前必須是 | 寫入結果 |
| --- | --- | --- |
| `notes.entry.create` | 尚無筆記 | 建立 `draft`，`revision = 1` |
| `notes.entry.update` | `draft` | 更新標題與本文 |
| `notes.entry.publish` | `draft` | 變為 `published` |
| `notes.entry.unpublish` | `published` | 變回 `draft` |

後三種成功操作都把 `revision` 加一。已發布筆記必須先收回草稿，再編輯並重新發布；收回後，它暫時不再出現在公開頁面。

在 [commands.ts](../../../packages/examples/notes/src/commands.ts)，`updateNoteHandler` 把來源狀態固定為 `draft`，`publishNoteHandler` 也要求 `draft`，`unpublishNoteHandler` 則要求 `published`。Theme 同時依狀態顯示表單，但伺服器仍獨立執行狀態檢查。

發布按鈕送出的是筆記 id 和 revision，發布的是**已儲存**的內容。若剛在編輯框改字，先按「儲存草稿」，重新開啟筆記後再發布。

## 3. 用 revision 擋住舊畫面的寫入

假設你在兩個分頁都開啟 revision `1`。第一個分頁儲存後，資料變成 revision `2`；第二個分頁仍拿著 `1`，不能直接覆蓋。

Repository 在同一個 UPDATE 裡檢查 id、作者、revision 和目前狀態：

```ts
const [row] = await tx.update(notes)
  .set({ ...patch, revision: revision + 1, updatedAt: now })
  .where(and(
    eq(notes.id, id), eq(notes.ownerActorId, owner),
    eq(notes.revision, revision), eq(notes.status, status),
  )).returning();
```

這是樂觀併發控制：允許同時開啟畫面，寫入時才確認版本仍然吻合。條件不符且資料確實屬於目前作者時，handler 回 `CONFLICT`，請你重新開啟筆記。它不會自動合併兩份文字。

依據：[repository.ts 的 change()](../../../packages/examples/notes/src/repository.ts)、[commands.ts 的 change()](../../../packages/examples/notes/src/commands.ts)。

## 4. 用 operationId 辨認同一次操作的重送

`revision` 解決「我拿的資料過期了嗎」，冪等鍵解決「這是不是同一個操作又送來一次」。兩個欄位目的不同。

頁面建立表單時產生 UUID `operationId`，[theme.ts](../../../packages/examples/notes/src/theme.ts) 把它放進 hidden input；[pages.ts](../../../packages/examples/notes/src/pages.ts) 收到後交給 Bus：

```ts
await ctx.commands.execute(name, input, {
  actor: ctx.actor,
  correlationId: randomUUID(),
  idempotencyKey: operationId,
});
```

Notes 的四個 Command 都要求 Actor-scoped 冪等。相同 Actor 對相同 Command 重送相同 key 與輸入時，可以回放既有成功結果；不要換一份內容卻沿用舊 key。另一個新操作需要新的 key，重新開啟編輯頁會取得新的 `operationId`。

表單另有 `_csrf`，用來防護瀏覽器寫入請求。它與冪等鍵、資料版本各有用途，不能拿其中一個取代另外兩個。實際整合測試會分別驗證重送與 stale revision；只看 hidden input 存在不能證明保護已生效。

## 5. 公開列表與內頁都要過濾草稿

公開頁面使用 `notes.entry.listPublished`／`getPublished`。Repository 的公開列表依 `status = 'published'` 過濾，公開內頁則同時比對 id 與狀態：

```ts
and(eq(notes.id, id), eq(notes.status, 'published'))
```

因此直接輸入草稿網址也取不到內容。作者自己的 `/my-notes/:id` 使用 `getMine`，能依擁有權讀到草稿與已發布筆記；公開 `/notes/:id` 使用 `getPublished`，作者也受公開狀態條件限制。

依據：[queries.ts](../../../packages/examples/notes/src/queries.ts)、[repository.ts](../../../packages/examples/notes/src/repository.ts)、[pages.ts](../../../packages/examples/notes/src/pages.ts)。

## 本課檢查點：用同一篇筆記完成驗收

以下操作會修改練習資料，只在第三課建立的本機環境進行。每次操作完都觀察結果，再進行下一步。

1. **A 建立草稿。** 登入後開 `/my-notes/new`，填寫並建立。回到 `/my-notes`，進入筆記並記下 id。匿名視窗開 `/notes` 和 `/notes/<id>`：列表不應有它，內頁應為不存在。
2. **B 嘗試查看 A 的管理頁。** 用另一個瀏覽器設定檔登入 B，直接開 `/my-notes/<id>`。應為不存在，B 的「我的筆記」也不應列出它。
3. **A 模擬舊畫面。** 在兩個分頁開啟同一篇草稿。第一頁修改並儲存；第二頁修改後送出，應得到衝突，不能蓋掉第一頁結果。重新開啟後確認內容。
4. **A 發布已儲存內容。** 重新進入筆記並按「發布」。匿名視窗重新整理 `/notes`，應能進入公開內頁讀到已儲存版本。作者編輯頁應提示先收回草稿。
5. **A 收回草稿。** 按「收回草稿」，再重新整理匿名列表與內頁。兩邊都不應再提供這篇筆記；A 仍能在自己的管理頁讀到它。

上述操作驗證瀏覽器可見的行為。另一帳號寫入、admin 擁有權限制、精確重送相同 key 等情境，請接著對照 [notes-example.test.ts](../../../tests/integration/notes-example.test.ts)。測試碼存在與測試通過是兩件事；下一課會執行檢查並說明證據範圍。

[下一課：測試、建置與交付 →](test-and-ship.md) · [上一課：頁面與 Release](pages-and-release.md)
