# B05 — Scheduler

狀態：五片全部實作完成，full gates 實跑；獨立審查 pending。
分支 `b05-scheduler`，基準 `837870c`（B04）。
依賴只以[計畫 §3](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

## 五片

1. **選型**：cron 運算套件比較與決策。
2. **宣告契約**：`PlatformModule.jobs[].schedule` 由 `{ everyMs }` 擴為可寫 cron 與時區，註冊時驗證。
3. **持久化排程狀態**：`platform_job_schedules` 與 migration `platform/0008_job_schedules`。
4. **Worker 整合**：到期 occurrence 只 enqueue，追補有上限，overlap 策略，多 worker 只留一筆。
5. **移轉與 ops**：pause／resume／list 的 command、query 與 CLI；ADR 0016 標記修訂。

## 契約

**排程只 enqueue。** `RecurringScheduler.ensureScheduled(now)` 算出到期的 occurrence 並寫進
`platform_jobs`，執行仍然由同一個 worker 從佇列取出，走 B04 的 occurrence fencing 與重試路徑。
沒有任何 in-process timer；行程重啟不遺失狀態。時間由呼叫端注入，所以測試不需要等真實時鐘。

**兩種宣告，一種身分。** `{ everyMs }` 沿用 ADR 0016 的 epoch 對齊切片；
`{ cron, timezone }` 用 croner 運算（[ADR 0038](../../adr/0038-cron-calculation-only-croner.md)）。
時區是必填的 IANA 識別碼。有歧義的縮寫被擋下——Node 的 `Intl` 會照收 `CST` 並解析成
`America/Chicago`、`EST` 解析成 `America/Panama`，靜默的錯誤位移比啟動失敗糟得多；
`Etc/GMT±N` 也擋，它的正負號與直覺相反。`Japan`、`Singapore`、`NZ` 這類 backward link 照收。
運算式除了語法，還會在註冊時正反各探一次：`0 0 30 2 *` 這種永遠不會發生的組合直接拒絕，
而 croner 回推不了的閏日排程（`0 0 29 2 *`，實測 `previousRuns` 丟 TypeError）由有界的
正向掃描補回來——**通過註冊的宣告，執行期不會再因為時間運算炸掉 worker**。

**遷移沒有雙排也沒有漏接。** 間隔式的去重鍵仍然是 `recurring:<type>:<bucket>`，
payload 仍然是 `{ bucket, scheduledFor }`——四個 commerce 模組的 `jobContractV1` v1 schema 是
`.strict()` 的，少一個欄位會讓在途工作被 quarantine。cron 另走 `recurring:<type>:at:<epochMs>`
與 `{ scheduledFor }`，兩種格式不可能相撞；改用 cron 的模組要自己宣告對應的 payload 版本。

**watermark 決定追補。** `platform_job_schedules.last_occurrence_at` 記住已經排到哪一次。
冷啟動時把它設成「當下這一次的前一次」，於是第一輪剛好補上當下這一次——與 ADR 0016 相同，
不會因為重啟而少跑一次。停機後 `(watermark, now]` 之間的 occurrence 全部算出來，
取最靠近現在的 `catchUp` 個（預設 1），其餘計入 `skipped_catchup`。單次列舉上限 1000。
宣告的頻率高過 worker 輪詢頻率時，註冊會留 warn——那代表多數 occurrence 會被無聲丟棄。

**暫停是跳過，不是延後。** 暫停期間 watermark 照常前進，所以恢復時不會湧出整段積壓。
狀態在資料庫而不是行程內快取，因此 pause 下一輪就生效，不必等到下一個切片。

**多 worker 由列鎖序列化。** 每一輪先 `SELECT … FOR UPDATE`，後到的 worker 讀到的是已經前進過的
watermark；去重鍵是最後一道防線。穩定狀態下這一輪不寫任何東西——排程器一直在跑，
每輪都 UPDATE 一次 `updated_at` 只是在製造 WAL 與 bloat。只有第一次見到這個排程、
宣告變了，或真的有 occurrence 到期時才寫。

**overlap。** 預設 `queue`：照排，每一次 occurrence 各自是一筆。`skip`：同型別還有
**已到期而未完成**的工作時不排新的（排在未來的那一筆不算，否則會把自己擋住）。
連續被擋下會累積 `consecutive_overlap_skips`，超過三次轉 warn——連續被擋多半代表上一次卡住了
（等 lease reclaim、被 concurrency policy 壓住、從死信 redrive 回來），不是它真的很忙。

**跳過的原因分開記。** `skipped_catchup`／`skipped_paused`／`skipped_overlap` 三個計數器，
去重不算跳過（那一次會執行，只是別的 worker 排的）。混成一個數字就沒有人能從它推斷
「這個排程正在出事」——健康的多 worker 叢集本來就會一直去重。

**單一排程的失敗不會拖垮整輪。** 每個排程一個 `boundedTransaction`（有 statement_timeout，
`FOR UPDATE` 不會被長交易無限期擋住），呼叫端逐一 catch 並記 error log。排程是「確保」不是
「執行」：這一輪沒排到，下一輪會再算一次同一個 occurrence，去重鍵讓重試不會變重複。

## 維運介面

`platform.jobs.listSchedules`（`jobs:read`）、`platform.jobs.pauseSchedule` 與
`platform.jobs.resumeSchedule`（`jobs:write`，需 idempotency key，寫 audit）。
CLI 對應 `schedule:list`、`schedule:pause <type>`、`schedule:resume <type>`。
未註冊的型別不能被暫停——否則狀態表會留下沒有人會讀的列。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `packages/platform/kernel/src/schedule-spec.ts` | 純時間運算：解析、驗證、occurrence 列舉、去重鍵與 payload。croner 只在這裡出現 |
| `packages/platform/kernel/src/recurring.ts` | watermark、暫停、列鎖、enqueue |
| `packages/platform/db/src/migrations/platform.ts` | `0008_job_schedules` |
| `packages/platform/db/src/schema.ts` | `jobSchedules` |
| `packages/platform/kernel/src/ops-module.ts` | list／pause／resume |
| `packages/platform/kernel/test/schedule-spec.test.ts` | 時間運算、驗證、錯誤隔離 |
| `tests/integration/scheduler.test.ts` | 真 PG：DST、追補、暫停、overlap、列鎖 |
| `tools/cli/src/main.ts` | `schedule:*` |

## 本片檢查

- `pnpm typecheck`：passed。
- `pnpm exec vitest run --project unit packages/platform/kernel/test/schedule-spec.test.ts`：26 passed。
- `pnpm exec vitest run --project integration tests/integration/scheduler.test.ts`：22 passed（真 PG）。
- `pnpm test:unit`：762 tests，1 failed。該失敗是 `tests/unit/theme-assets-http.test.ts`，
  **在 B04 基準 `837870c` 上以同樣方式失敗**（另開 detached worktree 實測），與本包無關；
  它依賴已建置的 admin／theme 靜態資產，B04 的 gates 是在 build 之後跑的。
- `pnpm test:integration`：見下方 gates 段落。

## 保留的缺口

- 排程狀態沒有 Admin UI；營運目前只有 HTTP command／query 與 CLI。UI 屬 B13。
- `skipped_catchup` 在單次列舉超過 1000 個 occurrence 時是下限而非精確值。
- 間隔式的去重鍵不含 `everyMs`（ADR 0016 的刻意繼承）。改 `everyMs` 時位移若小於約 0.15%，
  新 occurrence 可能撞上舊 occurrence 的去重墓碑而被靜默吃掉；要改就當成換一個排程宣告處理。
  已補記進 ADR 0016。
- 時區資料來自 runtime ICU；裁減 ICU 的 Node 會靜默算錯，屬 B15 的部署前檢查。
- **滾動部署期間改變排程宣告會真的跑兩套時間表。** fingerprint 翻動的唯一原因就是新舊版本
  宣告不同，而不同宣告算出的是不同時刻、不同去重鍵——去重鍵擋不住它們，兩套都會執行。
  對「每日發券」這種工作就是同一天發兩輪。要改排程宣告，必須先停掉舊版本再上新版本，
  不能滾動；這是操作前置，不是程式碼能擋的。
- watermark 為 NULL 的排程不會排任何東西。`lockRow` 會就地補上 anchor 讓它恢復；
  真的連一次過往 occurrence 都算不出來時會留 warn log，不會沉默。
