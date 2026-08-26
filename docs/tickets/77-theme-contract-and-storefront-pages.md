# 77 — Theme 契約收斂與前台品牌頁面

**What to build:** `packages/platform/kernel/src/theme.ts` 的
`renderJournalList?(ctx, data: { articles: any[] })` 用 `any` 表達契約，等於沒有契約；
另有 `isStoryPublished?` / `isJournalPublished?` / `isJournalArticlePublished?` 三支由
Theme 回答「這家商店發布了沒有」——那是資料狀態，不是 Theme 的事（ADR 0033）。把 DTO 收成
`ThemeArticleView` / `ThemeArticleListView` / `ThemeHomeView` / `ThemeContactView`，刪掉三支探測
方法，並在 `apps/api/src/storefront/storefront.controller.ts` 讓 `/story`、`/journal`、
`/journal/:slug` 改吃 Core 資料，新增 `/news`、`/news/:slug`、`/faq`。

**Blocked by:** 76

**Status:** completed

- [x] 選配 render 保留：方法有沒有實作表達的是「Theme 有沒有這個版型」，那是 Theme 的能力宣告
- [x] Theme 沒有對應版型，或商店沒有已發布內容，一律 404——不再退回首頁
- [x] 導覽列由 `commerce.content.getPublishedKinds` 一支彙總查詢驅動。原本想用 15 秒快取省下
      這次查詢，但那讓測試得睡 16 秒才驗得到導覽列；改成每次查（小表上的 distinct），
      測試從 17.9s 降到 1.3s，發布也立刻反映
- [x] `themeContext` 與 `renderError` 改成 async 之後，掃過全部呼叫點補上 `await`——
      漏掉會讓 Fastify 的回應永遠不送出
- [x] 已發布的品牌內容一律以匿名身分讀取。原本用 `actorOf(req)`，而 `readonly` 角色沒有
      `content:public-read`，會讓首頁整頁 403；改成結構上不看瀏覽者身分，而不是多一條要記得同步的角色清單
- [x] 文章的 `imageKey` 指向 Theme 已經拿掉的圖時，以無圖版型呈現而不是整頁失敗
- [x] 七個新版型全部補進 `packages/themes/default/test/escaping.test.ts` 的逸出探針
- [x] `tests/integration/storefront-content.test.ts` 以真的 HTTP 覆蓋 404、草稿不外流與導覽列

## 不做的事

- 首頁 hero 與品牌區塊各自一句文案。四種內容併成單一 `title` 之後，兩處讀同一篇故事，
  原本的兩句只剩一句；品牌區塊改用固定標題避免重複印同一句，另一句就此不再出現在站上。
