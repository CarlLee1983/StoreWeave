# 0003. PostgreSQL 為必要依賴，Redis 為選配

- 狀態：accepted
- 日期：2026-08-21

## 背景

單站部署常常是「一台 VM 一家店」。每多一個必要的中介軟體，就多一份安裝、監控、備份與故障來源。

背景工作與 Transactional Outbox 通常會讓人直覺選 Redis 或訊息佇列，但那會引入
「資料寫在 PostgreSQL、事件寫在 Redis」的雙寫問題——正是 Outbox 要解決的問題本身。

## 決策

PostgreSQL 是唯一的必要依賴。Outbox、工作佇列、Idempotency 紀錄、Audit Log 與
Extension 儲存全部放在同一個資料庫。

- 工作佇列用 `SELECT ... FOR UPDATE SKIP LOCKED` 取工作，可以多 Worker 併行。
- Outbox 轉送與「標記 relayed」在同一個交易內完成。
- 併發控制用 row lock 與唯一索引，不需要外部鎖服務。

Redis 目前完全沒有使用。未來若需要（快取、rate limit、跨程序 pub/sub），
它必須是**加速用的選配**：關掉 Redis 之後系統仍須正確運作，只是比較慢。

## 後果

- 備份就是 `pg_dump` 一份；還原就是 `pg_restore` 一份；沒有第二個狀態來源。
- `commerce doctor` 只需要檢查一個資料庫連線。
- 代價：高吞吐時佇列會與業務查詢競爭同一個資料庫；到那個量級之前不值得付出多一個元件的代價。

## Falsified if

`packages/platform/jobs/src/jobs.ts` 的 `SKIP LOCKED` 取工作在正式量級下成為資料庫瓶頸
（例如 Outbox 積壓持續成長且 `commerce doctor` 的 `outbox backlog` 長期為 warn），
或出現必須跨程序即時廣播的需求，而 `packages/platform/event-bus/src/registry.ts`
的資料庫輪詢模型無法滿足延遲要求。
