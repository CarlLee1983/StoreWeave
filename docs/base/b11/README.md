# B11 — Cache 與互斥鎖

狀態：`implemented`。本包實作 [Base 計畫的 B11](../../base-implementation-plan.md#b11--cache-與互斥) 與 Spec 0009 F11；它只依賴 B02，並在獨立 `b11-cache` worktree 進行。

## 設計邊界

- `@storeweave/cache` 是唯一公開入口。組裝層以 `RuntimeOptions.cacheBindings` 將固定為模組 id 的 `CacheScope`／`MutexScope` 注入模組；`Runtime` 不公開 manager，模組不取得 raw Keyv、raw Pool 或全域 clear。
- 快取使用 Keyv core 的序列化與 TTL 相容層，資料由 StoreWeave 的 pool-backed adapter 寫入 `platform_cache`。每一筆都必須有正的 TTL；過期、provider 失敗與資料庫錯誤不會被偽裝為 cache miss。
- `platform-cache/0001_init` 是獨立 migration owner，避免與 B05 的 `platform` migration 序列衝突，並讓 B02 的 release manifest／history 保留 table ownership。
- `platform_cache` 是 `UNLOGGED` 的非權威資料。崩潰後冷 cache 合法；帳本、session 撤銷與任何安全決策不得只存在這張表。
- `clear()` 是 `DELETE ... WHERE namespace = $1`。過期清理由 `FOR UPDATE SKIP LOCKED` 的 bounded batch 執行，可安全並行。
- mutex 用專用小型 pool 與 session-level PostgreSQL advisory lock；不使用 cache get/set。callback 完成後驗證 unlock 結果；不確定／失敗的 session 一律銷毀。backend 死亡會由 PostgreSQL 釋鎖，並不宣稱舊 JavaScript callback 的外部副作用會自動 fencing。

## Keyv adapter 選型

官方 stable `@keyv/postgres` 未採用：它會自行 DDL、使用 process-global pool、TTL 不可用 SQL bounded cleanup，且 namespace clear 的 `LIKE` 模式不能證明隔離。v6 尚非 stable、要求比本專案更高的 Node 版本，並仍持有自己的 pool。故採 `keyv@5.6.0` 加本包很小的既有-pool adapter，將 migration、TTL、namespace 與 lifecycle 置於本專案契約之內。

## 驗收

見 [acceptance.md](acceptance.md)。獨立 Sol/high review 已完成且無 P0/P1；完整 unit gate 的兩項既有失敗亦已記錄在驗收表。
