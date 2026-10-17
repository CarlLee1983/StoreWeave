---
title: "教學必須從使用走到可執行擴充，Base Blog 使用 API"
author: Carl
date: 2026-10-17
branch: fix/architecture-readability
touches:
  - docs/.vitepress/config.mts
  - docs/architecture.md
  - docs/index.md
  - docs/.vitepress/theme/index.ts
  - docs/.vitepress/theme/readability.css
  - docs/architecture/code-map.md
  - docs/architecture/events-and-jobs.md
  - docs/architecture/interfaces-and-admin.md
  - docs/architecture/modules-and-data.md
  - docs/architecture/platform-and-products.md
---

## Decided
使用者指出架構拆章仍缺教學。新增 docs/learn 四課：Base 本機啟動、Content journal Blog 生命週期、擴充責任判斷、可執行 Extension 記憶體練習。每課有前置條件、操作、預期結果與檢查點；架構作為原理解說回查。
## Tried and ruled out
只列架構與模組開發指南無法帶讀者完成工作。不要教新手到 Base /admin 發文，Base Admin disabled；文章走真實 content REST API。不要用直接修改共用 Base Theme 承載品牌需求。不要把測試中的 Extension 說成已安裝到網站。
## Watch out
Base exact selection 與 availableExtensions 空集合使得 YAML 任意加 extension id 無法載入。Content 仍保留 commerce.content 公開命名；journal 公開路徑為 /journal。已發布文章 update 立即公開，沒有雙版本草稿。四測試 SDK 範例正向全綠，刻意改壞 replay 後恰有一項失敗；這不是 Outbox/Worker/持久化驗證。Compose/API 教學為來源核對，未另建 DB 全程實跑。
