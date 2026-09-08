# B05 驗收追蹤：Scheduler

狀態：B05 blocked on B04；只有選型片交付。範圍為 F07 的 cron／timezone／DST、misfire、pause、overlap；
occurrence 執行、fencing、重試與 Outbox 屬 B04，不在本包。

依據：[計畫 §B05](../../base-implementation-plan.md)、[Spec 0009 F07](../../specs/0009-complete-modular-base.md#3-能力範圍與現況)、
[ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md)、[ADR 0038](../../adr/0038-cron-calculation-only-croner.md)。
依賴只以[依賴表](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

| 驗收項目 | owner | evidence | status |
| --- | --- | --- | --- |
| cron 套件選型有實測比較，主代理決策 | B05 | [cron-comparison.md](cron-comparison.md) 三套件、九組時區／DST／語法案例；`scripts/poc/base-b05` 四支探針執行完成 | implemented; review pending |
| 選型寫成可檢查的決策記錄 | B05 | [ADR 0038](../../adr/0038-cron-calculation-only-croner.md)，falsification 指名 `recurring.ts`／`worker.ts`／`module.ts` | implemented; review pending |
| cron 宣告契約與啟動前驗證 | B05 | — | blocked on B04 |
| Asia/Taipei 午夜可重現 | B05 | 探針已證明套件層正確（UTC 16:00）；StoreWeave 端排程路徑未實作 | partial; 套件層 only |
| 具 DST 時區 spring-forward／fall-back 可重現 | B05 | 同上：NY 02:30 順延 03:30、01:30 只排一次；另測 Lord Howe／Chatham／Tehran／Kathmandu | partial; 套件層 only |
| 停機補一次／有上限追補 | B05 | 探針證明可由過去時間點反向與正向列舉；追補上限策略與持久化未實作 | blocked on B04 |
| 暫停／恢復可重現 | B05 | — | blocked on B04 |
| overlap 策略可重現 | B05 | — | blocked on B04 |
| 多 worker 同時補排只留一筆 | B05 | — | blocked on B04（需 occurrence／dedupe 契約） |
| 原 `everyMs` 工作照常運作 | B05 | — | blocked on B04 |
| 排程只 enqueue，執行走同一 worker | B05 | ADR 0038 已把約束寫成 falsification 條件；程式碼未動 | 契約已定；實作 blocked |
| 舊排程遷移不雙排、不漏接 | A + B05 | — | blocked on B04 |
| 更新 ADR 0016 | B05 | ADR 0038 已記「0016 的理由繼續有效，實作落地後轉為部分被修訂」；0016 本身未改 | pending 實作 |
| 可控 clock 的運算測試 | B05 | 探針全部注入時間點，無真實時鐘相依；正式 unit test 未寫 | blocked on B04 |
| PG 競爭測試 | B05 | — | blocked on B04 |
| full checks 與 native/Docker gates | A | — | planned |

## 阻塞條件

解除需要三件事同時成立：B04 第四、五片與 full gates 通過並取得獨立審查；B04 實作 commit 進 main；
本分支 rebase 到含 B04 的基準。在那之前第二片起的任何實作都會建立在會變動的 occurrence 契約上。

選型片的 `implemented` 不構成 B05 accepted 證據，也不能據以把 F07 標為完成。
