# 0016. 週期性工作用時間切片，不用自我續排的鏈

- 狀態：accepted
- 日期：2026-08-22

## 背景

平台沒有排程器。`JobQueue` 只認得 `run_at`：在這個時間之後執行一次。既有唯一的使用者是
訂單的 15 分鐘預留到期工作，它本來就只需要跑一次。

但接下來有三件事需要固定週期重複執行：訪客購物車清理、生日禮券發放、會員等級重算
（Spec 0003、0004、0005）。`platform_jobs.dedupe_key` 是唯一索引，同一個鍵只能存在一筆，
因此「每小時再排一次自己」不能重用同一個鍵。

規劃時假定的做法是**自我續排**：工作在結束時排入下一次，每次換一個去重鍵。

## 決策

不用自我續排。時間被切成固定長度的**切片**，第 N 個切片對應唯一一個去重鍵
`recurring:<type>:<N>`，執行時間就是切片的起點。Worker 每一輪只做一件事：
確保「當下這個切片」已經排入佇列 —— 排過就被去重鍵擋下，沒排過就補上。

模組宣告週期性工作的方式是在 `PlatformModule.jobs` 的項目上加一個 `schedule: { everyMs }`，
不必自己處理去重鍵，也不必在 handler 裡記得排下一次。

## 考慮過的選項

- **自我續排（原本的假定）。** 否決：那條鏈只要斷一次就永遠接不回來。工作耗盡重試進了死信，
  就再也沒有人排下一次，而且**沒有任何地方會叫** —— 生日禮券會安靜地停發，直到有人發現。
  在 `finally` 裡續排可以撐過失敗，但撐不過行程在執行中被砍。用切片則根本沒有鏈可斷。
- **把 cron 排程器做進平台。** 否決：需要 cron 運算式解析、時區、錯過的補跑策略。
  目前的需求全部是固定間隔，不需要「每月第一個星期一」這種表達力。
- **交給作業系統的 cron / systemd timer。** 否決：與 ADR 0007 的單一 artifact 部署相衝，
  且會讓「這個 Release 有哪些週期性工作」離開程式碼、變成主機設定。

## 後果

- **停機期間跨過的切片不會被追補。** 醒來時只排當下這一個。需要追補的工作
  （例如補發昨天的生日禮券）必須自己在 handler 裡處理 —— 那是領域問題，不是排程問題。
- 切片邊界對齊 Unix epoch 而非本地時間。`everyMs = 24h` 的工作在 UTC 午夜跑，
  不是台北的午夜。需要對齊本地時間的工作目前得用較短的週期自己判斷，
  這是已知的限制，等真的有需求再處理。
- Worker 每一輪都會呼叫 `ensureScheduled`，但同一個切片在同一個行程內只會真的碰一次資料庫
  （行程內快取）。多個 worker 行程同時補排是安全的：去重鍵讓只有一筆留下。
- `WorkerTickResult` 多了 `recurringScheduled`。

## Falsified if

`packages/platform/kernel/src/recurring.ts` 的 `occurrenceKeyFor` 不再把切片編號放進去重鍵，
或 `RecurringScheduler.ensureScheduled` 不再由 `packages/platform/kernel/src/worker.ts` 的 `tick()`
每一輪呼叫，或 `packages/platform/kernel/src/module.ts` 的 `PlatformModule.jobs` 不再帶 `schedule`
—— 任一項成立，代表週期性工作換了別的機制，這篇記的理由要重新檢視。
