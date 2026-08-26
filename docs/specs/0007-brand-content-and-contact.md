# Spec 0007 — 品牌內容與聯絡我們

- 狀態：ready-for-agent
- 依賴：Spec 0001–0006
- 相關 ADR：0033（品牌內容是 Core 的 content 模組）、0034（編輯照片仍由 Theme 擁有）、0010（平台對領域中立）、0021（跨模組不加外鍵）、0024（輸入拒絕未知欄位）、0018（匿名寫入端點用 Origin 檢查）

## Problem Statement

具名商店現在只有商品、購物與會員動線。品牌故事與生活誌雖然已經上線，但寫死在 Theme 套件裡，
店家改不動；最新消息、常見問題與聯絡管道則完全不存在——顧客沒有地方讀到出貨公告，
也沒有地方問一句話。

這一輪把品牌內容變成店家自己維護得動的 Core 資料，並補上顧客送得出訊息、店家收得到的聯絡動線。

## Current Baseline

不重做的既有能力：

- Storefront SSR、Theme 契約、`/storefront-assets/` 的編輯照片交付（ADR 0034 保留）。
- 匿名寫入端點的 Origin 檢查（ADR 0018）——聯絡表單直接沿用，不另造一套。
- Admin 的抽屜表單、`StatusBadge`、`ErrorBanner`、`RowMenu`、`ReasonDialog` 與 34px 控制項高度規範。
- notification 模組維持現狀，這一輪不動它。

## User Stories

1. 作為店家，我要在後台新增與編輯最新消息、常見問題與生活誌文章，才不會為了一則公告發一版 Theme。
2. 作為店家，我要先存成草稿、確認後再發布，才不會把寫到一半的內容推到前台。
3. 作為店家，我要決定同一類內容的顯示順序，才不會只能依時間排。
4. 作為顧客，我要在前台讀到最新消息與常見問題，才知道出貨狀況與退換貨怎麼處理。
5. 作為顧客，我要送出一則訊息並看到明確的送出結果，才不用猜它有沒有寄到。
6. 作為店家，我要在後台看到所有聯絡訊息並標記處理狀態，才不會漏回。

## Scope and Decisions

### 1. 資料所有權

新模組 `packages/commerce/content`，擁有 `content_articles` 與 `content_contact_messages`
兩張表。不與其他模組加外鍵（ADR 0021）；`content_contact_messages.customer_id` 是選填的
弱參照，匿名訪客為 null。

### 2. Article 模型

單一 `content_articles`，`kind ∈ story | journal | news | faq`，`status ∈ draft | published`。
`slug` 在 `(kind, slug)` 上唯一。`body` 是段落陣列（jsonb），`image_key` 是 ADR 0034 的封閉 key。
`position` 決定同 kind 的顯示順序，相同時以 `published_at` 遞減。

`story` 這個 kind 每家商店至多一篇已發布——它是一頁式的品牌敘事，不是列表。這條由查詢端
取第一篇處理，不寫成資料庫限制：多一篇草稿是正當的編輯過程。

### 3. Command / Query 邊界

Command：`createArticle`、`updateArticle`、`publishArticle`、`unpublishArticle`、`deleteArticle`、
`submitContactMessage`、`markContactMessageHandled`。Query：`listArticles`（後台，含草稿）、
`getPublishedArticles`（前台，只回已發布）、`getPublishedArticle`、`listContactMessages`、
`getContactMessage`。

前台與後台走**不同的 query**，而不是同一支加參數。理由是「只回已發布」是前台的不變式，
它不該由呼叫端記得傳對旗標來維持。

### 4. 權限

`content:read`（後台讀，含草稿）、`content:write`（後台寫）、`content:public-read`（前台讀已發布）、
`contact:submit`（匿名可送）、`contact:read` / `contact:write`（後台收件匣）。
`content:public-read` 與 `contact:submit` 給 storefront 角色，其餘給 staff。

### 5. 聯絡表單的防濫用

SSR 表單 POST，沿用既有 Origin 檢查。另加 honeypot 隱藏欄位與同一 IP 的節流；
命中任一者回一般成功畫面而不是錯誤——讓機器人分不出差別，比擋下來更有用。
訊息落表後發 `commerce.content.contact.submitted.v1`，收件靠後台收件匣。

**這一輪不寄信。** notification 模組是訂單綁定的——`queueLifecycleDelivery` 必填 `orderId`，
收件人由 `recipientForNotification` 從訂單查出——沒有「寄一封任意信到 `supportEmail`」的路徑。
要接上它得先改它的收件人模型，那是 notification 自己的邊界，不該由這一輪順手改。
事件已經發出，日後補一個訂閱者即可，不必回頭改 content。

### 6. Theme 契約

`packages/platform/kernel/src/theme.ts` 的 journal `any` 換成 `ThemeArticleView` /
`ThemeArticleListView`；`isStoryPublished?` / `isJournalPublished?` / `isJournalArticlePublished?`
三支刪除（ADR 0033）；新增 `renderNewsList?` / `renderNewsArticle?` / `renderFaq?` / `renderContact?`
四支選配 render。`packages/themes/default/src/brand-content.ts` 刪除。

### 7. Storefront 路由

`/story`、`/journal`、`/journal/:slug` 維持路徑不變但改吃 Core 資料；新增 `/news`、`/news/:slug`、
`/faq`、`/contact`（GET 與 POST）。Theme 沒有實作對應 render，或查無已發布內容，一律 404。

## Acceptance Criteria

- [ ] 空資料庫時 `/story`、`/journal`、`/news`、`/faq` 皆回 404，`/contact` 仍可用。
- [ ] 後台建立的草稿不出現在任何前台頁面；按下發布後才出現。
- [ ] 同 kind 的內容依 `position` 排序，前台與後台一致。
- [ ] `(kind, slug)` 重複時 command 回可讀的錯誤，不是資料庫例外。
- [ ] 未登入訪客送得出聯絡訊息；缺 Origin 或 Origin 不符時被擋。
- [ ] honeypot 有值時回成功畫面，但資料表沒有新列。
- [ ] 聯絡訊息在後台收件匣可見，可標記已處理，且已處理的不能重複標記。
- [ ] `image_key` 指向不存在的圖時，前台以無圖版型呈現而不是失敗。
- [ ] 織日選物的三篇生活誌與品牌故事由 seed 注入，前台呈現與這輪之前一致。
- [ ] `pnpm test`、`pnpm test:integration`、`pnpm test:admin`、`pnpm typecheck` 全綠。

## Out of Scope

- 媒體上傳（ADR 0034 已記）。
- 內容的多語系版本、排程發布、版本歷史與預覽網址。
- 聯絡訊息的後台回覆功能與 email 通知——這輪只到「收得到、標記得了」。
- notification 模組的收件人模型擴充（讓它能寄非訂單信）。
- 內容的全文搜尋與 RSS。

## Delivery Order

1. `packages/commerce/content` 模組與 `tests/integration/content-domain.test.ts`
2. 接線：tsconfig paths、bundle 模組清單、roles、`content.controller.ts`、`app.module.ts`
3. Theme 契約改型別、Storefront 路由與 Default Theme 的四個新版型
4. Admin 品牌內容 CRUD 與聯絡收件匣
5. seed 資料搬遷與 `brand-content.ts` 刪除；architecture.md 與 CONTEXT.md 更新
