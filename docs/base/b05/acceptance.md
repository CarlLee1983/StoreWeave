# B05 驗收追蹤：Scheduler

狀態：五片實作完成；獨立審查兩輪已完成——第一輪 BLOCK（1 CRITICAL、2 HIGH、5 MEDIUM、6 LOW），
第二輪確認 C1／H1／H2／M1／M4／M5 真的修好、**無 CRITICAL 無 HIGH**，另發現 5 MEDIUM、6 LOW。
兩輪合計 25 項全部已修。**第三輪複審 pending**，因此 B05 尚未 accepted。
範圍為 F07 的 cron／timezone／DST、misfire、pause、overlap；occurrence 執行、fencing、重試與
Outbox 屬 B04，不在本包。

依據：[計畫 §B05](../../base-implementation-plan.md)、[Spec 0009 F07](../../specs/0009-complete-modular-base.md#3-能力範圍與現況)、
[ADR 0016](../../adr/0016-recurring-jobs-by-time-buckets.md)、[ADR 0039](../../adr/0039-cron-calculation-only-croner.md)、
[B04 驗收](../b04/acceptance.md)。依賴只以[依賴表](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

| 驗收項目 | owner | evidence | status |
| --- | --- | --- | --- |
| cron 套件選型有實測比較，主代理決策 | B05 | [cron-comparison.md](cron-comparison.md) 三套件、九組案例；`scripts/poc/base-b05` 四支探針 | implemented; review pending |
| 選型寫成可檢查的決策記錄 | B05 | [ADR 0039](../../adr/0039-cron-calculation-only-croner.md) accepted，falsification 指名 `schedule-spec.ts`／`recurring.ts`／`worker.ts`／`module.ts` | implemented; review pending |
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
| CLI／ops 註冊 | B05 | `platform.jobs.listSchedules`／`pauseSchedule`／`resumeSchedule`（權限、idempotency、audit）；CLI `schedule:list`／`pause`／`resume`，附 `--idempotency-key` 供重試同一次操作。暫停中不顯示「下一次」 | implemented |
| HTTP 入口與測試 | B05 | `GET /api/v1/system/schedules`、`POST /api/v1/system/schedules/:type/pause`／`/resume`（`system.controller.ts`）；`tests/integration/ops-http.test.ts` 13 例涵蓋真實資料的 list、暫停後 `nextOccurrenceAt` 為 null、帶點的型別走 path param、缺 `Idempotency-Key` 的 400 且確認未執行、重放不寫第二列 audit、readonly 的 403、未註冊型別的 404 | implemented（2026-09-09 補；原本三個入口**沒有路由**，不只是沒測試） |
| 更新 ADR 0016 | B05 | 0016 標記「排程機制部分由 0039 修訂」，補記兩項限制如何解除、理由如何保留；falsification 改指 `schedule-spec.ts` 並新增「不得自我續排」 | implemented |
| 可控 clock 的運算測試 | B05 | `packages/platform/kernel/test/schedule-spec.test.ts` 29 passed，全部注入時間點；含單一排程失敗不拖垮整輪 | implemented; 複審 pending |
| PG 競爭測試 | B05 | `tests/integration/scheduler.test.ts` 25 passed（真 PG，含列鎖阻塞與並行補排） | implemented; 複審 pending |
| full checks 與 native/Docker gates | A | typecheck PASS；unit 767 passed／1 pre-existing failure；integration 738 passed／0 failed | partial（smoke 屬 A） |

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

## 獨立審查（第二輪）

複審確認第一輪的修復不是搬家，並回答了兩個我特別問的問題：`boundedTransaction` 中途逾時
**不會**留下壞狀態（連線銷毀後 PG 端 rollback，watermark 前進與 enqueue 在同一交易所以一起消失，
最壞是下一輪被去重的重試）；惰性 anchor 對值**沒有行為差異**，只改變何時付出代價、何時丟例外。
三個不同意見（L2／L5／L6）複審皆同意我的處置，L2 明確認為原建議是錯的。

| 編號 | 內容 | 處置 |
| --- | --- | --- |
| N1 | M3 的 `run_at <= now` 過濾讓「重試退避中」的工作在 `overlap: skip` 下變成看不見；退避上限 600 秒，週期短於此且 handler 失敗時同型別會愈堆愈多 | 判準改為 `run_at <= now OR attempts > 0`；原註解的理由是假的（排程器只取 `(watermark, now]`，不可能擋住自己），已改寫 |
| N2 | H1 把 fail-loud 換成 fail-silent：`ensureScheduled` 永不丟，持續失敗的排程只會每秒印一行而無人察覺 | 加 `failed` 進 `EnsureScheduledResult`／`WorkerTickResult`；連續失敗 warn→error，成功歸零 |
| N3 | `timeoutMs` 是接不到設定的死欄位（runtime 沒傳），production 永遠 5000 且比 worker 自己的界限寬；且 N 個排程序列執行最長 N×5 秒，會拖垮 heartbeat 與佇列 | 預算改由 worker 呼叫時傳入自己的 `databaseTimeoutMs`；整個排程階段另設總預算 |
| N4 | 稀疏 cron 冷啟動會立刻跑一次陳年 occurrence（閏日排程 2026 年首次部署 → 跑 2024-02-29 那一期），而單元測試把它斷言成正確行為 | 加七天冷啟動陳舊界限，只約束冷啟動與宣告變更；既有排程週期最長一天，行為不變 |
| N5 | 縮寫黑名單漏掉最歧義的兩個：實測 `BST` → `Asia/Dhaka`、`IST` → `Asia/Calcutta` | 補入名單；`CET`／`EET`／`WET`／`JST`／`PRC` 實測後刻意放行並寫明理由 |
| N6 | fallback 視窗 8 年對 `count = 2` 不夠（閏日最大間距 8 年，2100 非閏年） | 放寬到 24 年，並記下「必須涵蓋 count+1 個間距」的規則 |
| N7 | fallback 的 `nextRuns(1000)` 實測 78 ms，且每輪都在持有寫鎖的交易內執行 | 按日快取 |
| N8 | `setPaused` 仍 eager 算 anchor，與 M5 不一致 | 改惰性，已存在的列不算 |
| N9 | migration `0008` 就地修改：安全，drift 偵測會讓開機報錯而非靜默缺欄位 | 無需改碼；README 補上「跑過中間版本的 dev／preview 資料庫必須重建」 |
| N10 | CLI 的型別宣告夾在 import 區塊中間 | 移到 import 之後 |
| N11 | README 的測試數字與 acceptance 不一致 | README 不再自己維護一份，改為指向本檔 |

## 獨立審查（第三輪）

範圍是第二輪的 11 項修正本身（`git diff e4a6a5d..HEAD`）。結論是 **Block**，唯一的阻斷項
是 T1；三個特別提問的疑慮，一項成立、一項不成立、一項成立但需補文件。

不成立的那一項值得記下來：**`attempts > 0` 不會讓永遠失敗的工作把排程永久擋住**。
`hasActiveJob` 只看 `status IN ('pending','running')`，而 `jobs.ts:422` 在
`attempts >= max_attempts` 時寫 `dead`，`reclaimStale` 對逾期租約同樣判 `dead`。
預設 `max_attempts = 5`、退避 `2^attempts`，擋住的時間上界約 62 秒；`requeue`／`retryDead`
與 deferred 置換都把 `attempts` 歸零，不會留下永久的未完成列。

| 編號 | 內容 | 處置 |
| --- | --- | --- |
| T1 (HIGH) | N3 的排程階段預算：`registered` 是插入順序、每輪起點固定，預算用完即 `break`，順序靠後的排程**無限期**排不到；而它們既不計入 `failed` 也只有邊界那一個進 log，外面只看到「一個排程偶爾抖動」。審查以假 DB 實跑三輪重現 | 起點輪替（`resumeFrom`：這一輪停在誰身上，下一輪從誰開始）；被延後的全部列進同一行 warn，並新增 `deferred`／`recurringDeferred` 與 `failed` 分開計。單元測試釘住三輪後每個排程都輪得到 |
| T2 (MEDIUM) | 只要 `remaining > 0` 就進場，交易預算 `Math.max(1, …)`——剩 3 ms 會開一個必定逾時的交易，而 `boundedTransaction` 逾時走 `client.release(error)`，等於每輪毀一條連線 | 加 `MIN_SCHEDULE_SLICE_MS = 250` 下限，不足即延後到下一輪 |
| T3 (MEDIUM) | N7 的按日快取：鍵是 UTC 日，但答案隨「有沒有跨過那一次」變化，而 occurrence 落在當地時區。實測 `0 0 29 2 *` @ `Asia/Taipei` 遲到約 8 小時（上界一天） | 快取改記真正的有效區間 `[validFrom, validUntil)`；掃描視窗內找不到下一次就不快取。順帶回傳複本，不再把快取裡的陣列交出去 |
| T4 (MEDIUM) | `hasActiveJob` 加上 `OR attempts > 0` 後 `platform_jobs_ready_idx` 完全接不住（狀態含 `running`，`run_at` 不再是範圍條件），實質是每個 skip 排程每輪一次全表掃描 | migration `0008` 補 `platform_jobs_active_type_idx ON platform_jobs (type) WHERE status IN ('pending','running')` |
| T5 (LOW) | 七天界限對「宣告變更」的後果沒寫進文件：改一個月排程的運算式會讓它最久一個月才第一次跑 | README 明說「改宣告 = 從下一次開始」；補整合測試釘住 |
| T6 (LOW) | `recurringFailed` 在 production 沒有消費者——`start()` 的迴圈丟棄 tick 回傳值 | README 改為據實描述：實際告警訊號是 warn→error 升級，計數只有 `drain()` 與測試讀得到 |
| T7 (LOW) | 冷啟動跳過的次數併入 `skipped_catchup`，維運分不出是停機太久還是政策決定 | 這一輪只在 README 註明兩種來源；獨立計數器留待有人真的需要時再加 |
| T8 (LOW) | 新行為缺測試：預算耗盡的 `break`、`fingerprint` 變更走冷啟動、`setPaused` 惰性 anchor | 三項各補一個測試（前者單元，後兩者整合） |
| T9 (LOW) | `backwardFallbackCache` 是模組層可變全域，且回傳快取內的陣列本身 | 併入 T3 一起改成回傳複本；清空入口未加 |

## 獨立審查（第四輪）

範圍是第三輪的 9 項修正本身（commit `f5fdddd`）。判定 **Warning：可合併，建議先修 M1**，
無 CRITICAL 無 HIGH。兩個重點疑慮都**成立為正確**：

- **T1 的輪替公平性成立。** 審查把排序與預算邏輯轉寫成可執行模型，跑 60 輪 × 七種耗盡樣式
  （慢排程在頭／中／尾、兩個交錯、全部中速、耗盡位置浮動、隨機成本），飢餓上界 N−1 輪，
  沒有任何排程從未排到。不變式是「每輪被服務的一定是 rotated order 的前綴，break 把游標設成
  第一個沒服務到的，只有整圈跑完才清成 undefined，而整圈跑完代表人人都排到了」。
- **T3 的快取有效區間成立。** 用真的 croner 10.0.1 對 `0 0 29 2 *`（Asia/Taipei、
  America/Los_Angeles）、`0 0 31 4 *`、`30 3 1 1 *`，`count ∈ {1, 2, 1000}`，
  2027-06 → 2030-06 逐小時比對 ground truth：**mismatches = 0**，含 `count` 大於可得次數、
  `at == validFrom` 與 `at == validUntil` 兩個邊界。

`count` 前綴污染、跨測試殘留、migration `0008` 的索引述詞與查詢不符——三項經查證皆不成立。
索引的部分述詞與 `hasActiveJob` 字面相同、前導欄 `type` 是等值條件，是這個查詢能拿到的最好形狀。

| 編號 | 內容 | 處置 |
| --- | --- | --- |
| M1 (MEDIUM) | 輪替引入的新邊界：`budget < MIN_SCHEDULE_SLICE_MS` 時第一圈就 break，游標設回 order[0]，**沒有任何排程進入迴圈本體**，`failed` 恆為 0，只有一行 warn 每個 poll 重複。修正前的 `remaining > 0` 至少還會跑第一個。config 路徑安全（`staleLockSeconds.min(10)` ⇒ `databaseTimeoutMs ≥ 1250`），但建構子選項繞過 zod | 順序上的第一個一律排（`index > 0` 才套門檻），交易切片同時縮成 `min(MIN, budget)`。單元測試釘住「至少排一個」與「游標有前進」 |
| M2 (MEDIUM) | 延後的 warn 不升級也不抑制，與同檔案對失敗、overlap 的分級不一致；「連續 N 輪排不完」是需要有人處理的容量訊號 | 加 `consecutiveDeferrals`，連續三輪升級成 error，排完整圈歸零；README 一併註明 `recurringDeferred` 在 production 同樣只有 log 讀得到 |
| L1 | 重入呼叫 `ensureScheduled` 會清掉游標，理論上讓飢餓復發 | 不改。目前不可達（`worker.ts` 的迴圈 `await this.inFlight` 之後才排下一輪，單一 Worker 內串行；跨 process 是不同物件），正確性由列鎖與去重鍵保護 |
| L2 | `result` 為空時 `validFrom = -Infinity` 誇大有效區間：更早的 `at` 帶著更早的視窗，可能含有這裡看不到的 occurrence | 改成 `windowStart.getTime()` |
| L3 | `result.slice()` 只複製陣列，`Date` 元素仍是共用實例 | 改成逐元素複製 |
| L4 | 公平性單元測試用 `Set` 丟掉次數與順序；`deferred` 欄位沒有測試 | 改斷言確定的軌跡，並斷言第一輪 `deferred === 2`、`failed === 1`。acceptance 原本寫「每個排程都輪得到」與實情有出入——`slow` 一律拋例外、從不 enqueue，釘住的是「後面兩個不再被餓死」 |
| L5 | 宣告變更的整合測試斷 `not.toBeNull()`，改動前就已成立，擋不住 watermark 被重設到錯誤時刻 | 改斷確切時刻 `2026-03-01T12:00:00.000Z` |
| L6 | `rotatedOrder` 註解說的熱重載路徑不存在（`registered` 沒有移除路徑） | 註解改成「防禦性退回」 |
| L7 | `deferred` 是階段層級的事實，卻出現在 `ensureOne` 的每個 return，型別說謊 | `ensureOne` 改回傳 `EnsureOneResult = Omit<EnsureScheduledResult, 'deferred'>` |

M1 的第二個建議（在 `worker.ts` 的時序不變式加 `databaseTimeoutMs >= MIN_SCHEDULE_SLICE_MS`）
**試過但撤掉**：它擋掉 `lifecycle.test.ts` 刻意用的短租約組態（lease 1000 ms ⇒ database 125 ms），
而那是合法的測試設定。排程器自己保證「至少排一個」之後，這道檢查沒有價值卻有代價。

## full gates（第二輪修正後實跑）

- `pnpm typecheck`：PASS。
- `pnpm test:unit`：61 files、771 tests、769 passed、2 failed。
  `tests/unit/theme-assets-http.test.ts` **在 B04 基準 `837870c` 上以完全相同的方式失敗**
  （以 detached worktree 實測比對），依賴已建置的靜態資產。
  `tests/unit/cli-upgrade.test.ts` 是 5 秒 timeout，而它每個 case 本身要 1.6 秒——
  單獨重跑 6 passed，在整批負載下超時。兩者都不是 B05 的程式碼問題，
  但完整跑時它們確實是紅的，不當成通過。
- `pnpm test:integration`：**86 files／738 tests 全數 passed**（`--maxWorkers=2`，真 PG testcontainers）。
  修正前的第一輪是 731 tests／5 failed，五項全是新 migration `0008` 造成的預期變更
  （migration 清單、資料表清單、pending 計數），更新後那五個檔案重跑 46 passed；
  第二輪完整跑曾被系統以記憶體不足中止（testcontainers 與本機其他資料庫容器並存），
  降低並行度後重跑取得上述結果。
- `smoke:docker`／`smoke:native`：未跑，屬 A 的 gate。

## full gates（第三輪修正後實跑）

- `pnpm typecheck`：PASS。
- `pnpm exec vitest run --project unit packages/platform/kernel/test/schedule-spec.test.ts`：31 passed
  （新增的兩個先確認過紅：餓死那個回 `Set {}`，快取那個回 `[]`）。
- `pnpm exec vitest run --project integration tests/integration/scheduler.test.ts`：28 passed。
- `pnpm exec vitest run --project integration --maxWorkers=2`：**86 files／741 tests 全數 passed**。
- `pnpm exec vitest run --project unit`：61 files、773 tests、772 passed、**1 failed**。
  只剩 `tests/unit/theme-assets-http.test.ts`（B04 基準 `837870c` 上同樣紅，依賴已建置的靜態資產）；
  `cli-upgrade` 這一次通過，印證它是負載相關的 flake 而非固定失敗。

## full gates（第四輪修正後實跑）

- `pnpm typecheck`：PASS。
- `pnpm exec vitest run --project unit packages/platform/kernel`：5 files、49 passed
  （`schedule-spec` 32 passed；M1 的測試先確認過紅——預算小於切片時 `enqueued` 是 `[]`）。
- `pnpm exec vitest run --project integration --maxWorkers=2`：**86 files／741 tests 全數 passed**。
- `pnpm exec vitest run --project unit`：61 files、774 tests、773 passed、**1 failed**
  ——仍然只有 `theme-assets-http`，B04 基準上同樣紅。

## 保留的缺口

- 第五輪複審尚未進行：第四輪的 M1／M2 與五項 LOW 修正本身沒有被獨立看過。
- L1（重入呼叫清掉游標）刻意不修，目前不可達；若將來同一 process 出現第二個共用
  `runtime.recurring` 的 Worker，這條就會變成真的，屆時把 order 與游標改成區域變數即可。
- T7 的獨立計數器（`skipped_cold_start`）沒有做，冷啟動與追補上限的跳過數仍混在同一欄。
- migration `0008` 這一輪再次就地修改（補索引）。理由與前次相同——它尚未部署，
  checksum drift 會讓跑過中間版本的資料庫開機即報錯而非靜默缺欄位；
  但任何跑過中間版本的 dev／preview 資料庫必須重建。
- `tests/unit/cli-upgrade.test.ts` 的 5 秒 timeout 餘裕過小，在負載下會 flake。不屬 B05，但值得修。
- ~~ops 的三個新入口只有 bus 層覆蓋，沒有帶真實資料的 HTTP 層測試。~~ 2026-09-09 補完，
  過程中發現這三個入口**根本沒有 HTTP 路由**（`apps/api` 底下零命中），所以原本的描述是誤述：
  不是測試沒補，是功能沒做，維運當時只能透過 CLI 操作排程。路由與測試已一併補上。
  這三個入口在補之前連 bus 層測試都沒有——`scheduler.test.ts` 全部直接呼叫
  `runtime.recurring.setPaused`／`list`，繞過 CommandBus／QueryBus，所以 descriptor 的
  output schema、permission 與 `toISOString()` 對映在此之前沒有任何覆蓋。
- 排程狀態沒有 Admin UI（屬 B13）。
- `skipped_catchup` 在單次列舉超過 1000 個 occurrence 時是下限而非精確值。
- 間隔式去重鍵不含 `everyMs`（L5，已補記進 ADR 0016）：微調週期時新 occurrence 可能撞上舊墓碑。
- 時區資料來自 runtime ICU；裁減 ICU 的部署會靜默算錯，屬 B15 的部署前檢查。
