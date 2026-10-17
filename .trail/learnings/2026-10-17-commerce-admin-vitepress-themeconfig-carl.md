---
title: "教學限制不禁止架構說明 Commerce Admin 或 VitePress themeConfig"
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
本次 trail check 對 config.mts:44 與 architecture.md:61 的 admin/content/theme/REST/API 關鍵字報警是語意誤判。前者是 VitePress 文件網站設定與導覽，後者說明六種介面及 Commerce 後台，不是在 Base 教學要求登入不存在的後台。保留這兩處正確內容。
## Tried and ruled out
本次未刪除有效的架構內容來消除關鍵字警告。
## Watch out
Base Blog 教學明確寫出 Base Admin disabled；Commerce 後台章節標示只適用 Commerce。獨立 reviewer 核對來源無實質問題。未提交或開 PR；未來提交訊息或 PR 應保留此衝突判斷依據。
