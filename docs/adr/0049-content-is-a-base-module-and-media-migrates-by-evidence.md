# 0049. Content 是 Base 模組，舊 Theme 圖片以可驗證回填遷移

- 狀態：accepted
- 日期：2026-09-11

## 決策

既有 `content` 模組移至 `packages/platform/content`，但保留 package 名稱、模組／migration owner `content`、
`content_articles`／`content_contact_messages` 表、`content/0001_init`，以及全部 `commerce.content.*`
command、query、event、page id 與前台 URL。這是位置變更，不是重新命名或複製資料；舊 Commerce
資料庫因此可沿用其 migration history、文章 id 與 `(kind, slug)` URL。

Content 僅必須依賴 platform。Commerce 可明確綁定 Customer projection 以填入 contact 的 `customer_id`；
Base 不綁定它。網站設定則可明確綁定聯絡通知收件人，已設定時在同一筆 contact transaction 建立 B07
email notification，未設定時仍保留原本收件匣流程。

`content_articles.media_asset_id` 是 additive expand，`image_key` 在 contract 前保留。公開圖片必須同時通過
「ready B10 asset」與「被已發布文章引用」兩個檢查；泛用 media preview 不變成匿名端點。Theme 先讀
`media_asset_id`，再回退 `image_key`。

預設 Theme 的 legacy manifest 固定列出 `(themeId, imageKey, file, altText, SHA-256)`。維運者使用
`content:backfill-legacy-media --assets-dir …` 匯入；操作先驗證原始 bytes digest，記錄 durable mapping，等
B10 worker 轉為 ready 後，重跑才在交易內補 article 欄位與 B10 reference。digest 不符、處理失敗或缺檔
都保留 failed evidence，不能跳過或靜默缺圖。

RSS、sitemap、robots 使用獨立的 published-only query；後台草稿查詢不得作為公開 feed 的資料源。

## 後果

- Base 能發布 story、journal、news、FAQ 與 contact，不建立 Customer 或 order。
- 文章的 legacy photo 在所有 mapping ready、digest 相符、文章欄位與 B10 reference 都對齊前，不能進 contract
  階段。`image_key`、Theme assets 和 static asset path 保留到 B17 後另行授權刪除。
- RSS/sitemap 是應用程式輸出，不承諾 CDN 或搜尋引擎何時抓取。

## Falsified if

若 B14 改寫 migration owner、複製文章到新表、讓匿名請求讀到未發布內容或泛用 media preview，或在沒有
mapping comparison evidence 時刪除 `image_key`／舊資產，必須重開本決策。
