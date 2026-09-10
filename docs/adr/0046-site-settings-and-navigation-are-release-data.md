# 0046. 網站設定與導覽是資料，不是 Theme 的一部分

- 狀態：proposed；B13 片2 開工前定案，實作與整合回歸通過後改 accepted。
- 日期：2026-09-10

ADR 0045 把前台頁面從 Theme 挪到模組宣告，但留下一段沒處理的東西：
`packages/themes/default/src/layout.ts` 仍然把導覽項目硬編碼成中文連結，標語
（tagline）則被當成 `theme.options` 的一個欄位。結果是換 theme 等於換一套導覽與
一套標語——資訊架構跟著外觀走，在任何一個真的換過 theme 的網站上都說不通。
`theme.options` 又是單一 record：換過去再換回來，原本的配色與標語已經被覆寫掉了。

## 決策

**導覽與網站設定存在資料庫，由 `platform-site` 模組擁有。** 兩張表：
`platform_site_settings` 是單列設定（標語、頁尾附註），`platform_site_navigation_items`
是導覽項目（menu slug、群組標題、文字、連結、排序、選配的內容種類條件）。
模組宣告 `data.owns`、自己的 migration，以及讀寫兩端的 query 與 command。
Theme 從 `ThemeContext.navigation` 與 `ThemeContext.tagline` 取得它們，不再自己列清單。

**menu 是 slug，不是列舉。** 平台不知道一個網站有幾組導覽——`primary`、`footer`
是預設 theme 的用法，另一個 theme 可以有 `utility` 或 `mobile`。同理，群組標題
（頁尾的「商品」「帳戶」）是導覽項目自己的欄位，不是平台認得的分類。

**沒有資料時回退到 release 的預設導覽，不是空選單。** `createSiteModule({ defaultNavigation })`
由 release 決定：commerce release 傳入原本硬編碼在 layout 裡的那份，base release
傳入只有首頁的最小版本。一張空表因此渲染出可用的網站，而不是一個沒有選單的殼；
店家改過某一組選單之後，資料庫裡那一組整批取代該 menu 的預設值——以 menu 為單位，
改了主導覽不會連頁尾一起消失。相反的做法——把預設值放進 migration
的 INSERT——會讓「刪掉這一項」在下一次遷移後復活。

**內容種類條件留在導覽項目上。** ADR 0033 建立的規則是「Theme 不猜哪些頁面存在」，
現行實作靠 `ctx.publishedContentKinds` 隱藏還沒發文的品牌連結。導覽變成資料之後，
等價物是導覽項目上的 `requires_content_kind`：storefront 在組裝 `ThemeContext` 時
比對已發布的種類並過濾。平台不解讀這個字串的意思，就跟它不解讀 `publishedContentKinds`
的成員一樣（ADR 0045）。

**`theme.options` 依 theme id 分開保存。** 設定檔的形狀從 `theme.options: {...}` 變成
`theme.options: { <themeId>: {...} }`，bootstrap 只驗證並回寫目前選用的那一組。
這是 ADR 0045 已經決定、當時未實作的部分，在這裡落地。**不提供相容路徑**：帶著舊的
扁平 `theme.options` 會在啟動時被 schema 擋下來，而不是安靜地被當成某個 theme 的設定。

**base release 因此有前台。** 它拿到 `platform-site` 模組宣告的首頁（`platform.site.home`）
與一個只實作通用頁的 `base` theme。這是本決策可被看見的結果：一個沒有任何商務模組的
網站能被瀏覽，證明前台不再需要商務領域。

## Falsified if

`packages/themes/default/src/layout.ts` 重新出現硬編碼的導覽項目清單，
或 `packages/platform/kernel/src/theme.ts` 的 `ThemeContext` 移除 `navigation`
而 theme 改回自行決定選單，
或 `packages/platform/site/src/migrations.ts` 開始 INSERT 預設導覽資料，
或 `packages/platform/config/src/schema.ts` 的 `theme.options` 退回單層 record，
或 `packages/platform/site/src/schema.ts` 出現任何商務概念的欄位（商品、訂單、購物車）；
任一成立表示資訊架構又被綁回外觀，或平台層又認得了商務領域，須重開本決策。
