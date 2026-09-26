# 118 — 歷史 Late Attempt 通知對帳測試的 drain 上限不足

**問題：** `tests/integration/booking-reservation.test.ts` 的
`reconciles a historical Late Attempt at a recorded cutoff without another payment or refund`
在完整套件中偶發失敗，預期一筆 `late-payment` 通知連結，實際為 `[]`。
失敗紀錄：本機 `make verify`（#114 首輪）與 CI run 36158939607 shard 2/2；
單獨重跑則 5/5 通過。

**狀態：** 已修正（測試 helper），產品程式碼未變更。

## 根因

`drainBookingNotificationWork()` 以 `concurrency: 1` 最多跑 100 輪，碰到上限時
直接回傳，不報錯。這支測試呼叫 `reconcileLatePaymentNotifications` 時，會為
檔案內先前所有尚無連結的 Late Attempt 重新發事件；reconcile 排的下一頁 job
在 drain 期間還會再發一輪。實測單次約 112–113 個 relay，超過 100 個 job
的預算。Attempt 依隨機 UUID 排序，所以本測試的投遞 job 是否落在前 100 個之內
也是隨機的。

失敗時的診斷輸出：drain 回傳 `processed: 100`，剛好等於上限；本 Attempt 的
兩個 `platform.event.deliver` job 仍是 `pending`，另有 16–17 個投遞 job 待處理。

## 驗收

- [x] 在完整檔案下重現：3 路平行共 15 次中失敗 2 次，並取得上述診斷證據。
- [x] drain helper 改為閒置才返回，上限 1,000 輪；未收斂則拋錯，不再默默少處理。
- [x] 修正後同樣 3 路平行 15 次，本測試 0 次失敗。
- [x] `make verify` 通過。

## 範圍外

同一輪壓力測試中，另有兩支測試偶發失敗，原因與本票不同，另開工單追蹤：

- `keeps a transient Base materialization failure retryable…`：修正前後都出現，並曾在三路同時失敗，疑似與時間點有關。
- `uses a hash-only checkout credential…`：retention job 回報 `failed: 1`。
