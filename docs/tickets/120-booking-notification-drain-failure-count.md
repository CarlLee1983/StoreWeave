# 120 — Booking 通知重試整合測試的失敗數不符預期

**問題：** 2026-09-26 文件同步工單 119 的首次 `make verify`，
`tests/integration/booking-reservation.test.ts:4397` 的
`upgrades a retryable event mapping to terminal Booker evidence and lets the following event retry settle`
預期 `drainBookingNotificationWork()` 回傳 `failed: 1`，實際為 `failed: 2`。
完整 suite 結果為 114/115 個整合測試檔案通過、1031/1032 個案例通過。

同一來源未改程式碼下，單獨執行該案例為 1/1 通過，整個
`tests/integration/booking-reservation.test.ts` 為 66/66 通過。
第二次完整 `make verify` 亦通過（integration 115/115 檔、1032/1032 案例）。
目前證據顯示失敗數斷言可能受同一輪 drain 處理的其他工作影響；根因尚未確定。
原始日誌：`/tmp/storeweave-docs-119-verify.log`、聚焦重跑
`/tmp/storeweave-docs-119-focused.log`、整檔重跑
`/tmp/storeweave-docs-119-booking-file.log`、第二次完整執行
`/tmp/storeweave-docs-119-verify-rerun.log`（本機暫存，非版本化證據）。

## 驗收

- [ ] 在完整 suite 下辨認第二個 failed job 的類型、來源與 reservation/event identity。
- [ ] 判斷是產品行為錯誤，還是測試把整輪 worker 結果當成本案例結果；依擁有邊界修正。
- [ ] 加入能穩定重現原失敗的回歸驗證，且不掩蓋真正的通知失敗。
- [ ] `make verify` 通過。

## 範圍

此票處理 Booking 通知測試／行為的失敗歸因；不屬於工單 119 的文件同步。
