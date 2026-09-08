# B00 — 基準、相容性與 Queue 選型驗證

狀態：done，2026-09-07。範圍與出口依 [Base 執行計畫](../../base-implementation-plan.md#b00--對齊基準與驗證選型)；完整能力依 [Spec 0009](../../specs/0009-complete-modular-base.md)。本包已交付研究、隔離驗證與後續派工契約，解鎖 B01；完整 Base 尚未完成。

## 基準與保存

- HEAD：`1f4470d810a84fc43d97c1990c32c5e71608dd7f`。Ticket 81–90 的 dirty tree 是已完成交付，不能 reset 或當作 B00 差異。
- [Ticket 90](../../tickets/90-admin-migration-closure.md) 已驗收：Admin 314、root 561、integration 505 tests；Docker smoke 62、native smoke 61；完整瀏覽器與 Sol 獨立審查 PASS。
- B00 起始 715 檔本機快照由 `/tmp/storeweave-base-b00-baseline-path` 指向；原 release 與六個無關 dbcli containers 保留。快照是本機比對證據，重跑 PoC 不依賴此路徑。
- 未確認商家實際部署／資料狀態，不能由本機 smoke 推定。既有 64／70 商家 UAT、91 ForgeFlowv2 來源待補不阻擋本包研究，也不算已完成。

## 執行順序與 ownership

| 步驟 | 狀態 | 責任與產物 | 出口 |
| --- | --- | --- | --- |
| 1. 基準與三項獨立調查 | complete | 主代理保存基準；Terra/high 寫 [公開介面盤點](compatibility-inventory.md) 與 [官方查證](pg-boss-research.md)；Sol/high 唯讀現有 Queue 分析 | 公開識別與 consumer 可追溯；官方版本／license／Node／PG 條件；七案例可執行契約 |
| 2. 同契約隔離 PoC | complete | 主代理單獨實作 [重跑方法與比較](queue-comparison.md)、[機器結果](queue-probes.json) | 14 probes 完成；獨立 typecheck PASS；功能缺口明列，不冒充完整能力 PASS |
| 3. 決策及 B01–B04 派工契約 | complete draft | [ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md)、[後續卡](next-work-cards.md) | 保留既有 Queue 並交付完整 F06／F07；無 production runtime 變更 |
| 4. 獨立審查與結案 | complete | 兩位獨立 Sol/high reviewers：Standards PASS／Spec PASS | 各 0 個未解 findings，B01 已解鎖 |

每份研究文件只有一位 writer；Queue／transaction／資料移轉的實作與選型由主代理負責。既有公開 id 與 payload 保持，未定的新 owner 標記為 B01 決策，不先造 rename 或永久相容層。

## 七項實測門檻

1. Drizzle transaction rollback 後 enqueue 不可留下工作，commit 才可見。
2. dedupe 回傳可追蹤的既有 identity，含併發與保留期邊界。
3. replaceExisting 遇 running 不可讓舊 handler 覆蓋新 occurrence。
4. crash／lease 能恢復，舊 owner 的完成／失敗不得污染新 owner。
5. DLQ 重送的 identity、attempts、payload 與重複操作語意明確。
6. timezone／DST 排程有可重現結果；尚未提供的 misfire／pause 能力必須列入 B05。
7. Queue schema upgrade 保留 pending／running／dead 狀態與 identity；migration 重跑及版本條件明確。

「套件沒有直接提供」要記為缺口與後續成本；PoC 對現況的 characterization 通過不等於 F06／F07 已完成。套件只安裝於隔離 package，不改根 manifest／lock；測試只建立並清理自己擁有的 PostgreSQL 資源。

## 審查與驗證紀錄

- Standards 首審 1 finding：初始化在 cleanup try 之外。已將 Database 初始化與第一個 SQL 納入保護範圍，`--fail-setup` 注入 PG 42883 後正確退出並清理；Sol 複審 PASS，0 個未解 findings。
- Spec 首審 2 findings：缺少 retry／DLQ 的升級列，以及 SDK／build env 盤點不全。升降版已補實測並通過，89 個 SDK exports 與公開 build inputs 已補列；Sol 複審 PASS，0 個未解 findings。
- 修正後正常 PoC：14 probes 完成，Node 22.17.1／PG 17.11；隔離 typecheck PASS。`npm ci --prefix scripts/poc/base-b00 --ignore-scripts --no-audit --no-fund` 可依 lock 重建 22 個 package 條目。
- 只改 B00 文件／PoC；原 release 2,461 檔 hash 相同，其餘基準檔未變，六個無關 dbcli containers 保留。未執行新的 production/Admin 全套回歸，因 B00 沒有其程式差異；前置證據見 Ticket 90。
- 本機終審證據：`/tmp/storeweave-b00-{standards,spec}-final.txt`、核准的 16 檔 hash `/tmp/storeweave-b00-reviewed-final.json`。兩位 reviewer 核對完整 log 與 JSON 一致、typecheck、故障清理、89 exports／148 routes 與選型理由；本段及入口的完成狀態在核准後更新。PoC／研究／review panes 均已結束，不保留執行中的測試資源。
