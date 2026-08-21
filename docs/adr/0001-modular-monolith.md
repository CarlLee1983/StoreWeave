# 0001. 以 Modular Monolith 為第一版架構

- 狀態：accepted
- 日期：2026-08-21

## 背景

每個客戶獨立建置、獨立部署、使用獨立資料庫，但共用同一套 Commerce Core。
單站的量級是「一家店」，不是「一個平台」；而 Core 必須能持續升級，客戶的特殊需求
不能污染 Core。

真正的限制不是流量，是**升級與邊界**：如果沒有明確的模組邊界，客戶需求會直接寫進 Core，
下一次升級就會踩到客戶的修改。

## 決策

第一版採用 Modular Monolith：單一程序、單一資料庫，但在程式碼層面維持嚴格的模組邊界。

- Core 模組（`catalog` / `inventory` / `order`）各自擁有自己的資料表與 migration。
- 模組之間**只能**透過對方匯出的 service 函式互動（例如 `catalogService.requireActiveProduct`、
  `inventoryService.adjust`），不得直接讀寫對方的資料表。
- 所有寫入走 Command Bus、所有讀取走 Query Bus；REST、MCP、Admin、CLI、Worker 共用同一批 handler。
- Extension 只能透過 Extension SDK 接入，不能碰資料層（見 ADR 0005）。

不採微服務，因為：單站部署下，跨程序呼叫只會把「一次資料庫交易」變成「需要 saga 的分散式交易」，
而我們最需要的保證正是「訂單狀態與 Outbox 事件在同一個交易內」。

## 後果

- 好處：一個交易就能保證一致性；部署只有兩個 process；本機開發不需要編排工具。
- 代價：所有模組共用一個程序的資源；想要獨立擴縮某個模組時必須先拆出去。
- 拆分路徑已經預留：Command / Query / Event 都是有版本的契約，未來要把某個模組拆成獨立服務，
  只需要換掉 Bus 的傳輸實作，呼叫端不必改。

## Falsified if

單一 Worker 程序無法在可接受延遲內消化 Outbox 積壓，或某個 Core 模組的資源需求
明顯壓迫其他模組，使 `packages/platform/kernel/src/runtime.ts` 必須為單一模組
提供獨立的資源配置；或模組之間出現無法用 `packages/commerce/*/src/service.ts`
表達的相依，必須直接跨模組查表。
