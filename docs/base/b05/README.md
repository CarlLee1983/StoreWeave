# B05 — Scheduler

狀態：**blocked**，只有第一片（選型）交付。分支 `b05-scheduler`，基準 `b23658e`。
依賴只以[計畫 §3](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

## 為什麼只做得了第一片

計畫 §3 與 §3.1 都寫明 B05 的前置是 B04，且「B04 整合驗收後才交給 B05」。
主工作樹的 `docs/base/b04/acceptance.md`（尚未 commit，故本 worktree 內不存在）目前是 `in_progress`：
第四、五片（Outbox fan-out、retention／dedupe horizon、ops）與 full gates 仍 `planned`，
dead-only replay 與七案例回歸也未通過。B04 的實作同樣全部未 commit，
本 worktree 由 `b23658e` 開出，樹內沒有任何 B04 程式碼。

因此本片只交付**不依賴 B04 的部分**：cron 運算的選型比較與決策。
第二片之後全部要接 B04 的 occurrence／fencing 契約，未解除阻塞前不動 production 程式碼。

## 第一片交付（本片）

- [cron／timezone 套件比較](cron-comparison.md)：cron-parser／croner／cronosjs 的實測結果，
  含 Asia/Taipei 午夜、NY 兩個 DST 轉換、Lord Howe 30 分鐘 DST、Chatham +12:45、
  Tehran 廢除 DST、Kathmandu +05:45，以及表達力與非法輸入。
- [ADR 0038](../../adr/0038-cron-calculation-only-croner.md)：選 croner，且只用其運算函式；
  排程只 enqueue，不持有 in-process timer。falsification 條件把這個約束寫成可檢查的形式。
- 隔離探針 `scripts/poc/base-b05`：獨立 `package.json`／`package-lock.json`，不屬 pnpm workspace，
  未改根 manifest、lockfile 或任何 runtime 程式碼。

未做：沒有新增 production 相依，沒有改 `packages/platform/kernel/src/recurring.ts`，
沒有 migration，沒有 CLI／ops 註冊。

## 剩下四片（全部 blocked on B04）

2. **宣告契約。** `PlatformModule.jobs[].schedule` 由 `{ everyMs }` 擴為可寫 cron 與 timezone；
   註冊時驗運算式與 IANA 時區，非法即啟動失敗（比照 [ADR 0036](../../adr/0036-validate-module-composition-before-runtime.md)
   的「啟動前驗證」）。既有 `everyMs` 宣告必須照常運作。
3. **持久化排程狀態。** occurrence 身分、`paused`、上次已排到哪個 occurrence、misfire 與 overlap 策略欄位，
   加一支向前 migration。occurrence 身分必須能對到 B04 的 dedupe／occurrence 契約，這是接 B04 的第一個真正介面。
4. **Worker 整合。** `tick()` 算出到期 occurrence 後只 enqueue；追補有上限；overlap 策略（skip／queue）可重現；
   多 worker 同時補排只留一筆。執行仍由同一 worker 走 B04 路徑。
5. **移轉與 ops。** 舊 `everyMs` 排程遷到新機制，不得雙排或漏接；CLI／ops 的 pause／resume／查詢；
   更新 [ADR 0016](../../adr/0016-recurring-jobs-by-time-buckets.md) 為部分被 0038 修訂；full gates。

## 本片檢查

- `node scripts/poc/base-b05/probe.mjs`、`probe-prev.mjs`、`probe-syntax.mjs`、`probe-odd-tz.mjs`：
  全部執行完成，結果記在比較文件的表格裡。
- 未跑 `pnpm typecheck`／test：本片沒有改動任何 workspace 內的程式碼。
