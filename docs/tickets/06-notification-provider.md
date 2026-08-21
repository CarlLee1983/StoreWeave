# 06 — 通知 Provider 與開發用實作

**What to build:** 擴充套件可以提供「寄送通知」這種服務，與付款、物流、ERP 並列。核心只認得介面：寄一封具名樣板的信給某個收件者。另附一個開發與測試用的實作，不真的連外。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 通知成為第四種 Provider 種類，宣告與取用都走既有的 Provider 機制
- [x] 有一個開發用的通知實作，會記錄寄出的內容供測試斷言
- [x] 通過既有的擴充套件契約檢查工具
- [x] 核心沒有任何 SMTP 或特定服務商的相依
