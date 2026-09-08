# B05 驗收追蹤：Scheduler

狀態：五片實作完成；獨立審查一輪已完成（BLOCK：1 CRITICAL、2 HIGH、5 MEDIUM、6 LOW，全部已修），
**修正後的複審 pending**，因此 B05 尚未 accepted。
範圍為 F07 的 cron／timezone／DST、misfire、pause、overlap；occurrence 執行、fencing、重試與
Outbox 屬 B04，不在本包。

依據：[計畫 §B05](../../base-implementation-plan.md)、[Spec 0009 F07](../../specs/0009-complete-modular-base.md#3-能力範圍與現況)、
[ADR 0016](../../adr/0016-recurring-jobs-by-time-buckets.md)、[ADR 0038](../../adr/0038-cron-calculation-only-croner.md)、
[B04 驗收](../b04/acceptance.md)。依賴只以[依賴表](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

| 驗收項目 | owner | evidence | status |
| --- | --- | --- | --- |
| cron 套件選型有實測比較，主代理決策 | B05 | [cron-comparison.md](cron-comparison.md) 三套件、九組案例；`scripts/poc/base-b05` 四支探針 | implemented; review pending |
| 選型寫成可檢查的決策記錄 | B05 | [ADR 0038](../../adr/0038-cron-calculation-only-croner.md) accepted，falsification 指名 `schedule-spec.ts`／`recurring.ts`／`worker.ts`／`module.ts` | implemented; review pending |
| cron 宣告契約與啟動前驗證 | B05 | `register()` 驗運算式、時區、catchUp、overlap，並**正反各探一次時間運算**：`0 0 30 2 *` 這類永不發生的組合拒絕，閏日 `0 0 29 2 *` 由有界正向掃描補回 croner 回推的缺陷。有歧義縮寫與 `Etc/GMT±N` 拒絕，backward link（Japan／NZ）接受。unit 12 例 | implemented; 已修 C1／L6，複審 pending |
| Asia/Taipei 午夜可重現 | B05 | unit：`0 0 * * *` → UTC 16:00 連三日；integration：真 PG 排出 `2026-01-04T16:00:00Z` | implemented; review pending |
| 具 DST 時區 spring-forward 可重現 | B05 | unit＋integration：NY `30 2 * * *`，03-08 的 02:30 順延 07:30Z，當天只有一次 | implemented; review pending |
| 具 DST 時區 fall-back 可重現 | B05 | unit＋integration：NY `30 1 * * *`，11-01 重複的 01:30 只排一次 | implemented; review pending |
| 非整點位移／30 分鐘 DST | B05 | unit：Australia/Lord_Howe；選型探針另涵蓋 Chatham、Tehran、Kathmandu | implemented; review pending |
| 停機補一次 | B05 | integration：跨 5 小時停機，預設只補最近一次，`skipped_catchup = 4` | implemented; review pending |
| 有上限追補 | B05 | integration：`catchUp: 3` 補最近三次而非最舊三次，`skipped_catchup = 2`；單次列舉硬上限 1000（unit） | implemented; review pending |
| 暫停／恢復可重現 | B05 | integration：暫停期間不排入且 watermark 前進，恢復後從當下這一次繼續、不補積壓；暫停下一輪即生效 | implemented; review pending |
| overlap 策略可重現 | B05 | integration：`skip` 在前一次**已到期未完成**時不排（未來筆不算重疊）；連續被擋累積 `consecutive_overlap_skips`，超過三次轉 warn，排入後歸零；`queue`（預設）照排 | implemented; 已修 M3，複審 pending |
| 多 worker 同時補排只留一筆 | B05 | integration：另開交易握住排程列的 `FOR UPDATE`，並行的 tick 在釋放前不完成也排不進東西，釋放後才補上——**列鎖獨立於去重鍵得到證明**；另有並行 `ensureScheduled` 只留一列 | implemented; 已修審查指出的無效斷言，複審 pending |
| 原 `everyMs` 工作照常運作 | B05 | integration：冷啟動即排當下切片；去重鍵仍為 `recurring:<type>:<bucket>`；payload 仍含 `bucket` 且通過既有 v1 strict schema。既有 `recurring-jobs`／`cart-cleanup`／`coupon-birthday`／`tier-recalculation`／`reward-expiry-notice` 回歸 | implemented; review pending |
| 排程只 enqueue，執行走同一 worker | B05 | `worker.tick()` 呼叫 `ensureScheduled` 後由 `runJobs` 執行；croner 只在 `schedule-spec.ts` 被 import，無 `schedule`／`trigger`／`name` 呼叫 | implemented; review pending |
| 舊排程遷移不雙排、不漏接 | A + B05 | 間隔式 occurrence 身分與 payload 逐欄不變，故遷移對在途工作是 no-op；`0008` 只新增資料表，不改既有列 | implemented; review pending |
| 排程狀態持久化 | B05 | `platform_job_schedules`＋`0008_job_schedules`；列入 platform release ownership metadata | implemented; review pending |
| CLI／ops 註冊 | B05 | `platform.jobs.listSchedules`／`pauseSchedule`／`resumeSchedule`（權限、idempotency、audit）；CLI `schedule:list`／`pause`／`resume`，附 `--idempotency-key` 供重試同一次操作。暫停中不顯示「下一次」 | implemented; HTTP 層測試 pending |
| 更新 ADR 0016 | B05 | 0016 標記「排程機制部分由 0038 修訂」，補記兩項限制如何解除、理由如何保留；falsification 改指 `schedule-spec.ts` 並新增「不得自我續排」 | implemented |
| 可控 clock 的運算測試 | B05 | `packages/platform/kernel/test/schedule-spec.test.ts` 26 passed，全部注入時間點；含單一排程失敗不拖垮整輪 | implemented; 複審 pending |
| PG 競爭測試 | B05 | `tests/integration/scheduler.test.ts` 22 passed（真 PG，含列鎖阻塞與並行補排） | implemented; 複審 pending |
| full checks 與 native/Docker gates | A | typecheck PASS；unit 767 passed／1 pre-existing failure；integration 735 passed／0 failed | partial（smoke 屬 A） |

## 獨立審查（第一輪）

Sol／high 等級的獨立審查回報 **BLOCK**：1 CRITICAL、2 HIGH、5 MEDIUM、6 LOW。全部已修，逐項如下。

| 編號 | 內容 | 處置 |
| --- | --- | --- |
| C1 | 合法但 croner 回推不了的 cron（`0 0 29 2 *`）通過註冊，`lockRow` 每輪計算 anchor 時丟 TypeError → `worker.tick()` → `failStop`，worker crash loop。我以 croner 10.0.1 實跑確認 | 註冊時正反各探一次；永不發生的組合拒絕，閏日由有界正向掃描補回 |
| H1 | `ensureScheduled` 無 per-schedule try/catch，註解宣稱的隔離不存在；任何 PG deadlock 會 fail-stop 整個 worker | 逐個 catch 記 error log 後續行 |
| H2 | 排程交易走裸 `transaction`，`FOR UPDATE` 無 statement_timeout，可被任一長交易無限期擋住而讓整個 tick 靜默停擺 | 改用 B04 的 `boundedTransaction` |
| M1 | watermark 為 NULL 的排程永遠不再排任何東西，且無告警 | `lockRow` 就地補 anchor；補不出來留 warn |
| M2 | 滾動部署改變宣告時兩張時間表都會執行，README 說「去重鍵擋下」過強 | README 改為據實描述，並寫明改宣告不能滾動部署 |
| M3 | `overlap: skip` 遇到卡住的工作會無聲永久跳過 | 排除未到期筆；連續跳過計數，超過門檻 warn |
| M4 | 暫停中仍顯示「下一次」；`skipped_count` 混了四種原因 | 暫停時回 `null`；計數器拆三類，去重不計入 |
| M5 | anchor 每輪白算（也是 C1 的引爆點）；每輪成本與鎖競爭 | anchor 改惰性求值，只有三條分支會用到 |
| L1 | 宣告頻率高過輪詢頻率時 occurrence 被無聲丟棄 | 註冊時比對間距與 `pollIntervalMs`，過近留 warn |
| L2 | CLI 每次產生新 idempotency key，重試會在 audit 留重複紀錄 | 加 `--idempotency-key`；預設仍為新鍵（固定鍵會讓「暫停→恢復→再暫停」讀到快取回應） |
| L3 | `selectForUpdate` 重讀後的 non-null assertion | 改丟帶 type 的 `PlatformError` |
| L4 | overlap 分支的 log 數字與回傳值／計數器分岔 | 統一成同一個數字 |
| L5 | 間隔式去重鍵不含 `everyMs`，微調週期可能撞上舊墓碑被靜默吃掉 | 不改鍵格式（會破壞遷移 no-op 前提），補記進 ADR 0016 |
| L6 | `includes('/')` 判 IANA 兩個方向都不準：拒絕合法的 `Japan`／`NZ`，放行正負號相反的 `Etc/GMT+8` | 改為擋歧義縮寫黑名單與 `Etc/GMT±N`，其餘交給 Intl |

審查同時確認：`ensureOne`／`lockRow` 的併發設計沒有 race（READ COMMITTED 下 `FOR UPDATE` 的 EPQ 重讀、
insert 競爭由 `DO NOTHING` 等待對方 xid 後重讀解決、enqueue 與 advance 同交易原子），跨排程不可能 deadlock，
`setPaused` 與 `ensureOne` 不會互相覆寫，遷移 no-op 的主張逐欄成立，時間運算沒有 off-by-one。

## full gates（修正後實跑）

- `pnpm typecheck`：PASS。
- `pnpm test:unit`：61 files、768 tests、767 passed、1 failed。唯一失敗是
  `tests/unit/theme-assets-http.test.ts`，**在 B04 基準 `837870c` 上以完全相同的方式失敗**
  （以 detached worktree 實測比對），依賴已建置的靜態資產，與 B05 無關。
  不能因為「本包沒動它」就當成通過——它現在確實是紅的。
- `pnpm test:integration`：**86 files／735 tests 全數 passed**（`--maxWorkers=2`，真 PG testcontainers）。
  修正前的第一輪是 731 tests／5 failed，五項全是新 migration `0008` 造成的預期變更
  （migration 清單、資料表清單、pending 計數），更新後那五個檔案重跑 46 passed；
  第二輪完整跑曾被系統以記憶體不足中止（testcontainers 與本機其他資料庫容器並存），
  降低並行度後重跑取得上述結果。
- `smoke:docker`／`smoke:native`：未跑，屬 A 的 gate。

## 保留的缺口

- 修正後的複審尚未進行。第一輪審查的 14 項都已修，但修正本身沒有被獨立看過。
- ops 的三個新入口只有 bus 層覆蓋，沒有帶真實資料的 HTTP 層測試——與 B04 留下的
  `listFailures`／`redriveFailure` HTTP 缺口是同一類，建議一起補。
- 排程狀態沒有 Admin UI（屬 B13）。
- `skipped_catchup` 在單次列舉超過 1000 個 occurrence 時是下限而非精確值。
- 間隔式去重鍵不含 `everyMs`（L5，已補記進 ADR 0016）：微調週期時新 occurrence 可能撞上舊墓碑。
- 時區資料來自 runtime ICU；裁減 ICU 的部署會靜默算錯，屬 B15 的部署前檢查。
