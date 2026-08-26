# 76 — content 領域模組與接線

**What to build:** 品牌內容目前是 `packages/themes/default/src/brand-content.ts` 裡的
TypeScript 常數，店家改不動。新增 `packages/commerce/content`，以單一 `content_articles`
承載 `story / journal / news / faq` 四種內容（ADR 0033：kind 決定的是呈現版型，不是欄位集合），
另加 `content_contact_messages`。照 `packages/commerce/rma` 的骨架：schema / migrations /
dto / repository / commands / queries / events / module，再接上 `tsconfig.base.json` 的 paths、
`packages/platform/bundle/src/modules.ts` 的 `coreModules()`、
`packages/platform/authorization/src/roles.ts`、`apps/api/src/controllers/content.controller.ts`
與 `apps/api/src/app.module.ts`。

**Blocked by:** —

**Status:** completed

- [x] `content_articles`：`(kind, slug)` 唯一；`position` 決定同 kind 順序，相同時看 `published_at`
- [x] 內文是區塊 `{ heading, text }[]` 而不是純段落——品牌故事的章節各自有標題，純段落表達不了
- [x] `(status = 'published') = (published_at IS NOT NULL)` 由資料庫 CHECK 守住，
      並把 `ContentRepository.update` 的型別收成聯集，讓同一條規則在編譯期就成立
- [x] 前台與後台走**不同的 query**：`listPublishedArticles` / `getPublishedArticle` 在
      repository 層硬編 `status = 'published'`，沒有旗標可以關掉——「只回已發布」是前台的
      不變式，不該靠呼叫端記得傳對參數
- [x] 權限拆成 `content:read`（含草稿）／`content:write`／`content:public-read`／
      `contact:submit`／`contact:read`／`contact:write`，並加進 `BUILT_IN_ROLES`
- [x] `tests/integration/content-domain.test.ts` 覆蓋草稿不外流、slug 唯一、排序、
      刪除、權限邊界與重複標記已處理
- [x] 加一支測試從 `information_schema` 比對 Drizzle 定義——`schema.ts` 與 `migrations.ts`
      是兩份各自手維護的真相（ADR 0008），沒有這道守門，漂移只會在某次查詢炸掉時才被發現
- [x] `Dockerfile` 的 workspace manifest 清單與 bundle 的已知事件清單同步補上——
      這兩處各有一個結構性測試會擋下漏掉的情況，那正是它們存在的理由

## 不做的事

- 內容的多語系版本、排程發布、版本歷史與預覽網址；全文搜尋與 RSS。
