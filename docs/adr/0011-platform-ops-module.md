# 0011. 死信佇列由平台維運模組公開，重送與 requeue 分家

- 狀態：accepted
- 日期：2026-08-21

## 背景

背景工作耗盡重試後會停在 `platform_jobs.status = 'dead'`，但這個狀態先前對外完全沒有開口：
沒有 Query、沒有 Command、沒有 HTTP 路由，只能直接連資料庫看。
Admin 的設計規格（`apps/admin/DESIGN.md`）把 DLQ triage 列為核心工作流，需要一組公開契約支撐。

兩件事要決定：這組契約屬於誰，以及重送的語意。

## 決策

**死信介面屬於平台，不屬於產品。** 新增 `packages/platform/kernel/src/ops-module.ts`，
由 `createRuntime` 永遠註冊，與 `options.modules` 傳進來的產品模組無關 ——
就像 `EVENT_DELIVERY_JOB` 一樣。它只讀寫 `platform_*` 資料表，對領域一無所知，
因此換一組產品模組不會讓維運介面消失。命名空間是 `platform.jobs.*`，權限是 `jobs:read` / `jobs:write`。

**死信重送與既有的 `requeue` 是兩個方法。** `JobQueue.requeue` 對任何狀態的工作都放行，
Extension SDK 也已經在用（demo-erp 的人工重送）。死信重送另開 `JobQueue.retryDead`，
`WHERE` 條件多一個 `AND status = 'dead'`，找不到就是 NOT_FOUND。

## 後果

- 重送一個**已完成**的工作會再產生一次外部副作用（例如對 ERP 重複建單）。
  `retryDead` 讓這件事在 DLQ 這條路徑上寫不出來，而不是靠呼叫端自律。
- 代價是兩段幾乎相同的 UPDATE SQL。這是刻意的：把狀態條件做成參數，
  等於把「可以重送任何狀態」重新變成一個呼叫端選項。
- `platform.jobs.*` 是公開契約，之後要改名或改語意須依 ADR 0006 的相容性政策處理。

## Falsified if

`packages/platform/kernel/src/ops-module.ts` 的 handler 開始 import 任何 `@storeweave/catalog`、
`@storeweave/inventory`、`@storeweave/order`，或 `packages/platform/jobs/src/jobs.ts`
的 `retryDead` 不再帶 `status = 'dead'` 條件。
