# 架構

## 目錄結構

```
apps/
  api/                  NestJS + Fastify：REST、Storefront SSR、Admin 靜態資源、MCP 端點
  worker/               背景工作行程：Outbox 轉送 + 工作佇列
  admin/                React 管理後台（Vite 建置成靜態資源，封裝進 Release）

packages/platform/
  contracts/            Actor、Command/Query descriptor、DomainEvent、錯誤型別（無相依）
  config/               commerce.yaml schema、載入器、Secret Provider
  db/                   Database（Drizzle + pg）、migration runner、平台資料表
  command-bus/          唯一寫入入口：授權 → 驗證 → Idempotency → 交易 → Audit → Outbox
  query-bus/            唯一讀取入口
  event-bus/            事件目錄與訂閱登記（不做即時派送）
  outbox/               Transactional Outbox
  jobs/                 PostgreSQL 背景工作佇列（SKIP LOCKED、退避重試、dedupeKey）
  authorization/        權限登記、Policy Registry、角色映射
  audit/                Audit Log 寫入與機密遮蔽
  extension-sdk/        Extension 的唯一公開介面（見 extension-development.md）
  kernel/               組裝：Runtime、ExtensionHost、Worker、健康檢查、Theme 契約
  bundle/               這個 Release 編進了哪些模組、Extension 與 Theme

packages/commerce/      Commerce Core：catalog / inventory / order
packages/extensions/    mock-payment / demo-erp / mcp
packages/themes/default 預設 Storefront Theme（SSR + 選用的 HTMX）
tools/cli/              commerce CLI
deployments/            example-store、example-store-two、systemd unit、設定 JSON Schema
```

## 一次寫入的完整路徑

以 `POST /api/v1/orders/:id/pay` 為例：

1. **ApiTokenGuard** 以 Bearer token 比對 `commerce.yaml` 的 `auth.tokens`（值來自 Secret Provider），
   解析出 Actor 與它的權限集合。
2. **Controller** 只做一件事：把 HTTP 請求轉成 `commands.execute('commerce.order.payOrder', input, {...})`。
   它沒有 repository，也沒有資料庫。
3. **CommandBus**
   - `authorization.assert()` 檢查 `order:write`，並讓已註冊的 Policy 有機會否決。
   - 用 descriptor 的 Zod schema 驗證輸入（失敗 → `VALIDATION_ERROR`，不是 500）。
   - `idempotency: 'required'` 的 Command 沒帶 key 直接拒絕。
   - 開啟資料庫交易。
4. **交易內**
   - 以 `INSERT ... ON CONFLICT DO NOTHING` 宣告 Idempotency Key。併發的第二個請求會卡在
     唯一索引上直到第一個 commit，然後讀到已完成的結果 —— 不會重複執行。
   - Handler 鎖住訂單列、呼叫 Payment Provider、寫入付款紀錄、更新訂單狀態。
   - `ctx.publish()` 把 `commerce.order.paid.v1` 寫進 `platform_outbox`（**同一個交易**）。
   - `ctx.audit()` 寫入 Audit Log（同一個交易），機密欄位先經 `redact()`。
   - 驗證輸出符合 descriptor 的 output schema，再把結果存回 Idempotency 紀錄。
5. **commit**。到這裡「訂單已付款」與「事件已排入」要嘛都成立，要嘛都不成立。

## 事件如何抵達 Extension

```
platform_outbox (pending)
      │  Worker.relayOutbox()：claimBatch + FOR UPDATE SKIP LOCKED
      │  同一交易內：對每個訂閱者排入一筆 job（dedupeKey = evt:<outboxId>:<subscriberId>）
      │              並把該筆 outbox 標記為 relayed
      ▼
platform_jobs (platform.event.deliver)
      │  Worker.runJobs()：claim → 在交易外執行 → complete / fail(退避重試)
      ▼
EventBus 訂閱者（Extension 的 event handler）
      │  投遞前用 Zod 驗證 payload
      ▼
Extension 自己再排一筆工作（ext.demo-erp.push-order，dedupeKey = 訂單 id）
      ▼
ErpProvider.push(doc)   ← 遠端以 reference 去重
```

去重發生在三個地方，任何一層重複都不會產生第二張 ERP 單據：

1. `platform_jobs.dedupe_key` 唯一索引：同一個事件對同一個訂閱者只會排入一次。
2. Extension 的投遞紀錄：`status === 'sent'` 就直接略過。
3. Provider Contract 要求以 `reference` 冪等：遠端自己認得重複的單號。

Extension 的錯誤只會讓那一筆工作失敗重試，核心訂單交易早已 commit，
不可能因為 ERP 掛掉而處於不一致狀態。

## 模組邊界

- Core 模組各自擁有自己的資料表與 migration（`catalog_*`、`inventory_*`、`order_*`）。
- 模組之間**只能**呼叫對方匯出的 service：`order` 扣庫存呼叫 `inventoryService.adjust(ctx, ...)`，
  取得商品呼叫 `catalogService.requireActiveProduct(tx, id)`。這兩個函式接受呼叫端的交易，
  因此跨模組操作仍在同一個交易內。
- Extension 只拿得到 `ExtensionContext`：Command API、Query API、Job API、
  以 extension id 隔離的 Store、宣告過的 Provider 與 Secret。沒有 `tx`、沒有 `db`。

## 介面共用同一組 handler

| 介面 | 進入點 | 走的路 |
| --- | --- | --- |
| REST | `apps/api/src/controllers/*` | Command Bus / Query Bus |
| Storefront SSR | `apps/api/src/storefront/*` | Command Bus / Query Bus（storefront 角色） |
| Admin | 靜態 SPA → REST | 同上 |
| MCP | `apps/api/src/mcp/mcp.controller.ts` | Command Bus / Query Bus（以呼叫端的 actor） |
| CLI | `tools/cli/src/main.ts` | 同一個 `bootstrap()` 與 Runtime |
| Worker | `apps/worker/src/main.ts` | 同一個 `bootstrap()` 與 Runtime |

`/api/v1/meta/commands`、`/meta/queries`、`/meta/events`、`/meta/permissions`
會輸出目前這個 Release 的完整契約（含 JSON Schema），可直接當整合文件用。
