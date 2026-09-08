# 0035. 完整 Base 沿用現有 PostgreSQL Queue，補齊可靠性契約

- 狀態：proposed；B00 實測與獨立 Sol 審查通過後供 B04 執行。
- 日期：2026-09-07

選擇保留 `platform_jobs` 與既有 transaction-aware `JobQueue`，由 B04 補齊 occurrence fencing、heartbeat、取消／逾時、保留期、去重及 Outbox 投遞語意；B05 完成交付 cron／timezone／DST 與 misfire 管控。這是完整 F06／F07 的後端選型，不代表現況已達標。

[B00 實測](../base/b00/queue-comparison.md) 證明 pg-boss 12.30.0 可在目前 Node／PostgreSQL 組合運作，且提供可靠的套件 schema 升降版與 heartbeat；但全狀態 dedupe、running replacement 和 dead-only 重送／attempt reset 不能直接映射其原生操作。兩套都需應用層 occurrence fencing；採 pg-boss 還要維護狀態翻譯、既有資料轉換與唯一 dispatcher 切換。原生 direct retry 可以保留 id，故 identity mapping 並非必然成本；若採 redrive 則需處理新 id。保留既有表使補齊工作集中在已被 Command／Extension／worker 使用的同一 Interface，減少同時改變持久資料格式與公開語意的範圍。

不新增 production pg-boss 依賴，也不以自製 cron parser 取代成熟套件。這項決策的代價是 StoreWeave 必須長期維護 Queue SQL、併發與故障測試；若 B04 的同契約實作無法通過多 worker／舊 owner／外部副作用恢復驗證，必須重開本 ADR，不能降低驗收標準。B00 不移轉或刪除任何正式資料；B04 的向前 migration 保留現有 id／dedupe／payload，回復條件依該工作包契約驗證。

## Falsified if

`packages/platform/jobs/src/jobs.ts` 不再以 `platform_jobs` 為唯一 persisted job identity，或 B04 正式 `tests/integration/queue-reliability.test.ts` 無法滿足 per-occurrence fencing／crash recovery／replacement 契約，或 `packages/platform/kernel/src/worker.ts` 改由另一個 Queue dispatcher 執行；任一成立均重開選型與移轉評估。
