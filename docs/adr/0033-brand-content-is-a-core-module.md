# 0033. 品牌內容是 Core 的 content 模組，Theme 只負責呈現

- 狀態：accepted
- 日期：2026-08-26

## 背景

`f578662` 讓織日選物的品牌故事與生活誌上線，資料放在
`packages/themes/default/src/brand-content.ts`：三篇文章與品牌敘事以 TypeScript 常數寫死在
Theme 套件裡，`StorefrontTheme` 用四支選配方法（`renderStory?` / `renderJournalList?` /
`renderJournalArticle?` 與對應的 `is*Published?`）把它接到路由上。

那一輪只有品牌故事與生活誌，兩者都是「寫一次、幾乎不動」的編輯內容，靜態常數是合理的。
現在要補的是最新消息、Q&A 與聯絡我們——前兩者的本質是**店家會持續新增與修改的營運內容**：
一則出貨公告、一條剛被問到的常見問題，都不應該需要改一支 `.ts`、跑一次 build、發一版 Theme。

同時，`theme.ts` 上的 journal 方法簽章是 `data: { articles: any[] }`。契約用 `any` 表達，
等於沒有契約：Theme 與 Storefront 之間沒有任何東西保證兩邊看的是同一個形狀。

## 決策

品牌內容是 Core 的資料，由新的 `packages/commerce/content` 模組擁有；Theme 只拿 DTO 呈現，
不再擁有任何內容常數。

**一種型別，用 `kind` 區分。** `content_article` 一張表承載 `story` / `journal` / `news` / `faq`
四種內容，共用 slug、標題、內文、發布狀態、排序與稽核紀錄。理由是這四者在領域上是同一件事——
一段具名、可發布、有順序的編輯文字——差別只在前台把它們排成什麼版型。分成四張表會讓
「發布」「排序」「slug 唯一」這三條規則各寫四遍，而它們每一遍都必須一樣。

FAQ 的「問」落在 `title`、「答」落在內文；品牌故事的章節是內文的段落區塊。這是刻意的：
kind 決定的是**呈現版型**，不是欄位集合。哪一天某個 kind 真的長出別的 kind 沒有的欄位，
那才是拆表的時機。

**選配 render 保留，但探測方法收掉。** `renderStory?` 這種「方法有沒有實作」表達的是
**Theme 有沒有這個版型**，這是 Theme 的能力宣告，留著。而 `isStoryPublished?()` 表達的是
**這家商店有沒有發布這篇**，那是資料狀態，不是 Theme 的事——它移到 content 模組的
`status` 欄位，由 Storefront 查詢決定 404 與否。Theme 不再需要知道哪些內容存在。

**DTO 收成正式型別。** `any` 換成 `ThemeArticleView` 與 `ThemeArticleListView`，
與 `ThemeProductView` 同列在 `packages/platform/kernel/src/theme.ts`。這些型別描述的是
「一篇可發布的編輯文字」，不是商店語彙，因此不違反 ADR 0010 對 kernel 的中立要求。

**聯絡我們的訊息也歸這個模組**，`content_contact_message` 一張表。它與文章共處一室的理由是
兩者服務同一個顧客動線——讀了品牌內容之後想問一句話——而不是因為資料像。

## 後果

- `packages/themes/default/src/brand-content.ts` 刪除，那三篇生活誌與品牌故事轉成 seed 資料。
  依「不做向後相容」的規則，不保留讀靜態常數的 fallback 路徑：內容只有一個來源。
- 商店必須先有內容才有頁面。空資料庫的 `/journal`、`/news`、`/faq` 回 404，與現在
  未發布時的行為一致。
- Admin 多兩塊畫面，其中品牌內容 CRUD 是後台第一個「以文字為主體」的編輯介面。
- 文章配圖不隨這個決定進 Core，見 ADR 0034。
- 內容不進定價、不進訂單、不發任何影響交易的事件。CONTEXT.md 已寫明品牌內容不是商品事實的
  來源，這個模組不改變那一點。

## 考慮過的選項

- **維持 Theme 靜態內容，只加新的 kind。** 否決：最新消息與 Q&A 的更新頻率決定了它們必須
  可被店家編輯，而 Theme 是建置期的產物。真要走這條路，等於承諾每則公告都發一版 Theme。
- **Article / Announcement / FaqEntry 三個獨立型別。** 否決：三份 CRUD、三塊 Admin 畫面，
  換來的是三組其實一樣的發布與排序規則。等到某個 kind 真的需要自己的欄位再拆。
- **內容留 Theme、只把聯絡訊息進 Core。** 否決：那會讓同一類東西有兩個來源，而生活誌
  永遠不能被店家編輯——這正是這輪要解掉的問題。

## Falsified if

`packages/commerce/content/src/schema.ts` 的 `contentArticles` 不再以 `kind` 欄位區分內容型別
（拆成多張表），或 `packages/platform/kernel/src/theme.ts` 重新出現 `is*Published` 這類由 Theme
回答資料狀態的方法，或 `packages/themes/default/src/` 底下重新出現具名的品牌內容常數。

第一項成立代表「四種內容是同一件事」的判斷被推翻，第二項代表發布狀態的歸屬又回到 Theme，
第三項代表內容重新有了第二個來源——任一成立，這篇的分界就要重新檢視。
