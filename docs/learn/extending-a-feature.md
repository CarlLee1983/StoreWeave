---
description: 從 Blog 需求判斷設定、Theme、模組與 Extension 的分工，並用既有範例練習開發與驗證。
pageClass: architecture-page
---

# 從 Blog 延伸自己的功能

完成[上一課](build-a-blog.md)後，你已經能發布文章。接下來的問題是：「我想做的功能超出現有文章能力，該從哪裡加？」

這課先教你找對位置，再沿專案裡已存在的模組學習實作順序。**留言和外部同步是待實作的練習需求，不是複製一段設定就會出現的功能。**

## 第一步：把需求寫成使用者能完成的動作

不要從「我要做一個 Blog 模組」開始。先寫「讀者可以閱讀已發布文章」「會員可以留言，編輯審核後才公開」。前者上一課已完成；後者才需要新規則與資料。

以這張表挑選起點：

| 你想做到的事 | 先使用哪一層 |
| --- | --- |
| 建立、發布、下架文章 | 現有 Content 的 Command 與公開 Query |
| 更換網站名稱、導覽或主題色 | 既有網站設定與 Theme 選項 |
| 改文章列表、字體或內頁版面 | Theme renderer |
| 增加留言、審核狀態與自己的資料表 | 新模組，透過 Release 組裝 |
| 文章發布後同步至外部服務 | Extension，透過事件與背景工作整合 |

這些可以組合使用。一個有留言的 Blog 可以沿用 Content 儲存文章，讓留言模組只負責留言，再用 Theme 呈現兩者的頁面。

依據：[模組開發](../module-development.md)、[Theme 與頁面決策](../adr/0045-modules-declare-storefront-pages.md)、[Extension 的執行環境](../extension-development.md#extensioncontext-extension-唯一的執行環境)。

## 第二步：先完成一個外觀練習

先從不增加資料表的改變開始。閱讀 [Base Theme 的文章 renderer](../../packages/themes/base/src/index.ts)：

1. 找到 `commerce.content.journalList`。它接收已經整理好的文章列表，再產生 HTML。
2. 找到 `commerce.content.journalArticle`。它接收單篇文章，由 `renderArticle` 呈現標題、摘要和段落。
3. 找到 `escapeHtml`。標題與段落是使用者輸入，不能直接當作 HTML 插入。
4. 找到 `renderBaseLayout`。它讓自訂畫面沿用網站導覽、外框與基本 SEO 欄位。

**練習目標：** 為自己的 Theme 寫一個文章列表 renderer，在標題下加入每篇文章的摘要，保留文章連結與分頁。
Base 已有摘要渲染，可以先理解它，再修改自己的排列與樣式。資料仍從原本的 Page view 取得，renderer 不查資料庫，也不決定草稿是否公開。

真正的組裝範例在 [file-requests 的 storefront projection](../../packages/examples/file-requests/src/storefront.ts)：它展開既有 Theme 的 `renderers`，再加入自己的 renderer。
新 Theme 應放在自己的套件或站點組裝中；不要直接改共用 Base Theme 來承載某個網站的品牌需求。

::: warning Theme 不會建立路由
把頁面標題改成「Blog」不會把 `/journal` 變成 `/blog`。路徑由模組 Page 宣告，Theme 只處理呈現。第一版沿用 `/journal`，需要新路徑時再設計頁面宣告與相容的舊連結行為。
:::

**完成檢查：** 同一篇已發布文章仍能閱讀；草稿仍不能公開閱讀；標題中的 `<` 會顯示為文字；第二頁的連結仍可用。只有外觀改變時，文章資料與發布規則不應改變。

## 第三步：有新資料與規則時，沿完整模組範例練習

專案沒有內建留言模組。不要先複製一整套 Content；先讀一個範圍完整、可以測試的例子：[`file-requests`](../../packages/examples/file-requests/src/module.ts)。
它處理檔案申請，不是 Blog，但包含新功能常需要的資料、權限、Command、Query、背景工作與頁面。

### 先跑範例的契約檢查

在已安裝依賴的 repository 根目錄執行：

```sh
pnpm exec vitest run --project unit packages/examples/file-requests/test/contract.test.ts
```

預期該測試通過。它檢查組裝與宣告，不會證明資料庫或 HTTP 流程正確。閱讀[測試本身](../../packages/examples/file-requests/test/contract.test.ts)，看它如何把 Release 和模組名稱交給 `runModuleContractChecks`。

接著開啟 Docker，跑既有整合範例：

```sh
pnpm exec vitest run --project integration tests/integration/file-requests-example.test.ts
```

這會透過 testcontainers 建立測試資料庫；需要 Docker 與可用的容器映像，不使用上一課的 Blog 資料庫。
預期測試走完授權上傳、背景處理、查詢、審核及通知等流程。整合測試比契約測試慢；不要把仍在啟動容器當成完成。

### 依一次操作的順序讀程式

| 順序與問題 | 對照檔案 |
| --- | --- |
| 輸入有哪些欄位？誰能送出？ | [types.ts](../../packages/examples/file-requests/src/types.ts)、[commands.ts](../../packages/examples/file-requests/src/commands.ts) |
| 狀態存在哪裡？哪張表屬於這個模組？ | [schema.ts](../../packages/examples/file-requests/src/schema.ts)、[migrations.ts](../../packages/examples/file-requests/src/migrations.ts) |
| 使用者怎麼讀結果？ | [queries.ts](../../packages/examples/file-requests/src/queries.ts) |
| 長時間工作由誰執行？ | [jobs.ts](../../packages/examples/file-requests/src/jobs.ts) |
| 哪個 URL 顯示結果，誰負責 HTML？ | [pages.ts](../../packages/examples/file-requests/src/pages.ts)、[theme.ts](../../packages/examples/file-requests/src/theme.ts) |
| 這些檔案如何接起來？ | [module.ts](../../packages/examples/file-requests/src/module.ts)、[runtime.ts](../../packages/examples/file-requests/src/runtime.ts) |

讀完後，用一句話描述：「使用者送出什麼、系統存成什麼狀態、下一個人如何看見結果」。能說出這條路徑，再開始設計自己的功能。

## 第四步：把留言需求拆成一個可驗證的小功能

以下是**設計練習**。名稱與狀態是建議，尚未在 StoreWeave 註冊，不能拿去呼叫 API。

第一版只做「會員送出留言，編輯核准後公開」。先不加回覆樹、按讚、附件或寄信。

1. **定義資料。** 留言需要文章識別、作者識別、本文、狀態與時間。由留言模組擁有自己的表與 migration；不往 `content_articles` 塞新欄位。
2. **定義寫入。** 送出留言產生 `pending`；編輯核准後變成 `approved`，拒絕則變成 `rejected`。這些轉換由 Command 處理。
3. **定義讀取。** 公開 Query 只回傳已核准留言；編輯 Query 才能看待審清單。隱藏按鈕不能取代後端授權。
4. **定義跨模組依賴。** 送出前要確認文章可留言，但不能直接讀 Content 的 repository。先確認公開 Query 或明確的能力契約能否滿足需求；需要「檢查文章與寫留言必須同時成立」時，還要設計交易與併發規則。
5. **定義頁面。** 模組宣告讀者送出表單與編輯審核頁面；Theme 負責 HTML，Release 決定誰拿到留言及審核權限。
6. **定義生命週期。** 文章下架、刪除或會員停用時，留言要如何處理？先決定，再寫測試；不能假設跨模組外鍵會替你解決。

**先寫出驗收情境：** 會員留言後，匿名讀者看不到；編輯核准後才看得到；沒有審核權限的會員不能自行核准；文章下架後，留言頁不能繼續洩漏文章內容。

實作時照[模組開發的建立套件、migration、權限與測試步驟](../module-development.md)完成。契約測試之外，仍要有狀態轉換、授權與 HTTP 整合測試，最後執行 `make verify`。

## 第五步：把自己的功能組成 Release

模組檔案存在，不代表網站已經使用它。Release 必須選擇模組、授權角色、Theme 與各執行目標。

Base 的 [ReleaseDefinition](../../packages/releases/base/src/definition.ts) 會檢查固定的模組、Theme 和 Extension 清單；[Base runtime](../../packages/releases/base/src/runtime.ts) 的 `availableExtensions` 也是空的。
因此不能在 Base YAML 隨便加一個 `blog` 或 Extension 名稱，就期待它被載入。

建立自己的站點 Release 時，以 [file-requests 的 definition](../../packages/examples/file-requests/src/definition.ts) 與相鄰 target projections 為對照：

- Definition 宣告選擇與 target keys。
- Runtime 組裝模組與角色，storefront projection 提供 Theme。
- Server、Worker、CLI、config 與 Admin projection 各提供自己的貢獻；是否提供後台必須明確決定。
- 在 [build registry](../../scripts/releases.mjs) 登記建置入口，依[模組開發的 Release 組裝步驟](../module-development.md#_11-組進-release)檢查 seed 與部署需求。

**完成檢查：** 建置成功、啟動時模組圖通過、所有必需頁面有 renderer；然後才驗證留言的成功與拒絕流程。只修改組裝清單並不等於功能完成。

## 第六步：整合外部服務時，改走 Extension

假設你要在文章發布後同步到外部內容平台。現有發布事件名稱是 **`commerce.content.article.published.v1`**，即使 Content 已被 Base 使用，這個公開名稱仍保留歷史前綴。
payload 包含 `articleId`、`kind`、`slug` 與 `occurredAt`，不是整篇文章本文。

依據：[Content 事件宣告](../../packages/platform/content/src/events.ts)。

你的 Extension 可以訂閱事件，再透過允許的 Query 取得資料、排入自己的背景工作。外部呼叫失敗交由重試與人工處理，不能讓讀者誤以為「本機已發布」就等於「外部同步完成」。
尤其要先定義重複發布、同步期間文章下架，以及遠端成功但本機尚未記錄成功時的處理方式。

這是下一個獨立練習，需要外部服務的實際契約與自己的 Release 組裝。實作參照 [Extension 開發](../extension-development.md)及 [demo-erp 的投遞範例](../../packages/extensions/demo-erp/src/handlers.ts)；它示範整合機制，不代表文章同步已存在。

## 自我檢查：你會把它放在哪裡？

先自己回答，再展開說明。

::: details 只想把文章列表改成兩欄，需要新模組嗎？
不需要。資料和發布規則沒變，先改自己的 Theme renderer 與樣式；同時保留手機閱讀、分頁與安全的文字插值。
:::

::: details 留言需要待審狀態，可以只藏掉前台按鈕嗎？
不可以。狀態與審核權限必須在後端 Command／Query 執行，公開查詢也要排除待審留言。Theme 只控制畫面。
:::

::: details 文章發布後，外部同步失敗，要把文章改回草稿嗎？
這是產品決策，不是事件機制自動提供的行為。通常分開記錄發布與同步狀態，允許重試；若業務要求同步成功才公開，就必須明確設計新的發布流程。
:::

完成這課後，先為自己的第一個功能寫出「使用者動作 → 資料與狀態 → 權限 → 畫面 → 成功與失敗驗證」。有了這張小規格，再選對應的開發指南實作。

想先親手完成一個小擴充，可以接著做[第四課：文章發布紀錄 Extension](extension-lab.md)。它提供完整程式與測試，在記憶體裡驗證事件處理，再說明安裝到 Release 還需要哪些工作。
