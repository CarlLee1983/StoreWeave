---
description: 從新增自己的功能出發，按實際檔案理解模組、Command、Query、頁面、Theme 與 Release 的分工。
pageClass: architecture-page
---

# 第一課：平台給了什麼，我要寫什麼

假設你要做一個短筆記網站：作者儲存草稿，確認後發布，訪客讀取公開筆記。你第一個要找的是**這個功能的模組宣告**。它像一張接線表，列出功能擁有的資料、寫入、讀取、權限與頁面，再由 Release 把這張表接進應用。

本課先建立讀程式的方法。第二課會用 Notes 的小範例實作；這裡也用已存在的檔案處理申請模組對照，讓你能立即在倉庫中核對這些接點。

**本課完成條件：** 能從 `module.ts` 找到一個寫入與一個讀取的實作，指出 Theme 和 Release 的不同工作，並為自己的需求列出第一批要改的檔案。

## 1. 先找到功能的接線表

開啟 [file-requests 的 module.ts](../../../packages/examples/file-requests/src/module.ts)，找到 `createFileRequestsModule()` 的 `defineModule({...})`。先看下面五個欄位：

| 宣告 | 先回答這個問題 | 你會看到的具體例子 |
| --- | --- | --- |
| `name` | 這個模組叫什麼？ | `file-requests` |
| `data.owns`、`migrations` | 它擁有哪些資料，資料表怎麼建立？ | `file_requests_records` 與 `fileRequestMigrations` |
| `commands` | 它允許哪些寫入？ | 送出申請、重試、審核 |
| `queries` | 它提供哪些讀取？ | 讀取單筆、列出自己的申請、審核清單 |
| `pages` | 它提供哪些前台入口？ | `fileRequestPages` |

這個完整範例還有上傳、排程與通知，第一次閱讀先沿上述欄位追讀即可。Notes 的需求較小，後續課程會從較少接點開始。

`defineModule()` 本身回傳你提供的宣告；它不會替你產生資料表或業務規則。模組載入時，平台才核對名稱、相依、版本、資料與契約是否相容。依據：[模組契約](../../../packages/platform/kernel/src/module.ts)、[模組圖檢查](../../../packages/platform/kernel/src/module-graph.ts)、[ADR 0036](../../adr/0036-validate-module-composition-before-runtime.md)。

**檢查點：** 找出 `submitFileRequestCommand` 在哪裡註冊，以及它對應的 handler。兩個名稱通常一起出現在 `commands` 陣列中；前者描述契約，後者執行行為。

## 2. 要儲存資料，就沿 Command 找到規則

使用者按下「儲存筆記」時，頁面需要送出一個明確的寫入意圖。StoreWeave 把這種意圖稱為 **Command**。每個 Command 有兩部分：

- **Descriptor：** 宣告名稱、輸入與輸出 schema、所需權限，以及是否要求冪等鍵。
- **Handler：** 檢查產品規則，再透過 `ctx.tx` 讀寫資料。例如是否允許修改目前狀態、要保存哪些欄位。

沿 [commands.ts](../../../packages/examples/file-requests/src/commands.ts) 的 `submitFileRequestCommand` 與 `createSubmitFileRequestHandler` 閱讀，再追到 [repository.ts](../../../packages/examples/file-requests/src/repository.ts)。這條路徑把「輸入長什麼樣」與「哪些變更有效」接在一起。

CommandBus 依 descriptor 執行授權、輸入驗證、交易、適用的冪等保護與輸出驗證。你要寫的是筆記的規則；交易執行機制由平台提供。只在程式裡直接呼叫 handler，並不等於驗證過這條 Bus 路徑。依據：[CommandBus](../../../packages/platform/command-bus/src/command-bus.ts)。

**檢查點：** 如果新增「標題不可空白」，先看輸入 schema；如果新增「已發布後不可修改」，先看 handler 的狀態條件。兩種限制都屬於 Notes 的契約與規則。

## 3. 要顯示資料，就沿 Query 找到讀取範圍

頁面重新整理時，需要讀取目前資料。這種讀取稱為 **Query**，也有 descriptor 與 handler；QueryBus 執行授權、輸入與輸出驗證，提供 `ctx.db` 給 handler。它沒有 CommandBus 的寫入交易與冪等流程。

看 [queries.ts](../../../packages/examples/file-requests/src/queries.ts) 的 `listMyFileRequestsHandler`，再看它如何把 `ctx.actor.id` 帶到 repository。`Actor` 是這次操作的身分與權限脈絡；查詢要自己決定能讀哪些資料。QueryBus 不會因為函式名字有 `My` 就自動限制資料列，也不是攔截任意 SQL 的唯讀沙箱。

回到筆記需求，你至少需要區分「作者可管理的資料」與「訪客可閱讀的資料」。公開列表和公開內頁都要限制在已發布資料；只在畫面上隱藏草稿連結，仍無法保護有人直接輸入網址的情境。

依據：[QueryBus](../../../packages/platform/query-bus/src/query-bus.ts)、[Account 與 Session 詞彙](../../../CONTEXT.md)、[資料擁有權決策](../../adr/0005-data-ownership.md)。

**檢查點：** 找到一個 Query 的 permission 與資料篩選條件，分別說明「能不能執行這個操作」和「能讀到哪些資料」。

## 4. 要讓瀏覽器操作，才接頁面與 Theme

接著追 [pages.ts](../../../packages/examples/file-requests/src/pages.ts) 和 [theme.ts](../../../packages/examples/file-requests/src/theme.ts)。先問三個具體問題：網址在哪裡宣告？頁面資料從哪裡來？最後 HTML 在哪裡產生？

| 位置 | 責任 | 放回筆記網站的例子 |
| --- | --- | --- |
| 頁面宣告 `pages.ts` | page id、路徑、輸入、受眾、權限，以及 `resolve` 的操作流程 | 接收筆記 id，呼叫公開 Query，取得頁面 view |
| Command／Query handler | 產品規則與可讀資料 | 拒絕無效寫入；只回傳已發布筆記 |
| Theme renderer | 把 view 渲染成 HTML，決定排版與樣式 | 把標題與內文排成文章頁 |

有寫入的頁面可以執行 Command，再回傳轉址結果；不必每個頁面都產生 HTML。Theme 接收的是頁面 view，不能靠 CSS 決定資料是否公開。平台在啟動時檢查必需頁面有沒有 renderer，減少使用者點進頁面才發現缺畫面的情況。依據：[頁面契約](../../../packages/platform/kernel/src/page.ts)、[Theme 契約](../../../packages/platform/kernel/src/theme.ts)、[ADR 0045](../../adr/0045-modules-declare-storefront-pages.md)。

**檢查點：** 假設只要換筆記標題的字體，應改 Theme；假設要讓訪客讀不到草稿，應追 Query、權限與其測試。指出兩者各自的檔案。

## 5. 要把功能跑成應用，最後找 Release

模組描述一項能力；**Product Release 選取能力，組成可獨立建置與部署的應用**。平台提供組裝契約與執行工具，實際選擇由 Release 擁有。

繼續看同一範例的 [definition.ts](../../../packages/examples/file-requests/src/definition.ts) 與 [runtime.ts](../../../packages/examples/file-requests/src/runtime.ts)：前者記錄 Release 身分、選取清單與各 target key；後者接起實際模組、角色、Theme 與執行設定。

各目標的入口稱為 **target projection**。例如 [server.ts](../../../packages/examples/file-requests/src/server.ts) 提供伺服器需要的組裝，[cli.ts](../../../packages/examples/file-requests/src/cli.ts) 提供 CLI 需要的能力。這讓各目標匯入自己的入口；瀏覽器目標不必把後端工廠一起打包。

這裡要區分兩個常見名稱：

| 名稱 | 代表什麼 | 對你開發 Notes 的意義 |
| --- | --- | --- |
| Platform 與 Base Module | 可供選用的執行機制和共用能力，例如網站設定、認證 | 使用既有接點，省下重寫連線、登入與授權機制的工作 |
| Base Release | 已選好網站、內容、認證等能力的一個具體應用組合 | 適合前一條 Blog 路線，但它的選取清單不是任意模組的容器 |
| Notes Release | 本路線的獨立應用組合 | 選用網站、認證與自己的 Notes，擁有自己的 Theme 和資料庫 |

因此，「使用 StoreWeave 這個開發框架」會落到具體動作：寫模組契約與 handler，使用平台提供的執行機制，再建立一份 Release 把需要的能力接起來。部署時交付的是這份組裝後的應用與設定。

依據：[Release 契約](../../../packages/platform/release/src/release-definition.ts)、[Base Release 選取檢查](../../../packages/releases/base/src/definition.ts)、[平台與產品](../../architecture/platform-and-products.md)、[詞彙表的 Product Release 定義](../../../CONTEXT.md)。

## 帶著一張檔案清單進入下一課

現在把「作者儲存並發布筆記」拆成你要追的檔案。先記住讀取順序，具體程式碼會在下一課逐步展開。

| 順序 | 要找的檔案 | 要回答的問題 |
| --- | --- | --- |
| 1 | `module.ts` | 哪些能力已註冊？資料與權限由誰擁有？ |
| 2 | 資料 schema 與 migration | 一筆筆記如何保存？狀態與欄位如何表示？ |
| 3 | `commands.ts`、`queries.ts` | 哪些輸入有效？哪些狀態可改？每種身分能讀什麼？ |
| 4 | `pages.ts`、`theme.ts` | URL 如何接到操作？view 如何變成 HTML？ |
| 5 | `definition.ts`、`runtime.ts` 與各 projection | 這個產品實際選了哪些能力？各執行目標從哪裡進入？ |
| 6 | 測試 | 如何證明寫入成功，以及無權限、草稿外洩等失敗情境被擋住？ |

**離開本課前：** 用自己的話回答「筆記規則要寫在哪裡」「Theme 能不能決定誰可讀資料」「新增 Notes 為什麼需要自己的 Release 組裝」。如果還不能指到檔案，回到上面的對照表追一次即可。

[下一課：寫出第一個模組 →](first-module.md) · [回到從零開發路線](index.md)
