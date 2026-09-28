# 120 — Booking 通知重試整合測試的失敗數不符預期

**問題：** 2026-09-26 文件同步工單 119 的首次 `make verify`，
`tests/integration/booking-reservation.test.ts:4397` 的
`upgrades a retryable event mapping to terminal Booker evidence and lets the following event retry settle`
預期 `drainBookingNotificationWork()` 回傳 `failed: 1`，實際為 `failed: 2`。
完整 suite 結果為 114/115 個整合測試檔案通過、1031/1032 個案例通過。

同一來源未改程式碼下，單獨執行該案例為 1/1 通過，整個
`tests/integration/booking-reservation.test.ts` 為 66/66 通過。
第二次完整 `make verify` 亦通過（integration 115/115 檔、1032/1032 案例）。
後續診斷確認根因是測試將共享 Worker 的整輪 `failed` 計數當成目前案例的結果。
`drainBookingNotificationWork()` 會處理同一資料庫內所有到期工作；另一個 Reservation
的事件可能在同一輪失敗，Booking 通知本身的重試行為沒有發現產品錯誤。
原始日誌：`/tmp/storeweave-docs-119-verify.log`、聚焦重跑
`/tmp/storeweave-docs-119-focused.log`、整檔重跑
`/tmp/storeweave-docs-119-booking-file.log`、第二次完整執行
`/tmp/storeweave-docs-119-verify-rerun.log`（本機暫存，非版本化證據）。

診斷時的整檔執行捕捉到同一輪兩個 `platform.event.deliver` 失敗工作：
`booking.reservation.confirmed.v1`（Reservation
`f2f0f2aa-ffbd-4695-967b-d9d12078c76e`、event
`a3aa211f-6353-4e0c-8b8e-ae383eec2b49`）與另一個 Reservation 的
`booking.reservation.cancelled.v1`（Reservation
`7a0dba9e-3db8-4cfc-b73b-71c151781346`、event
`f79f2144-e303-4559-b5a3-7ad0684d1a26`）。原始完整 suite 日誌沒有記錄隨機
UUID，無法事後還原那次的精確身分；整檔診斷及新增的雙 Reservation 回歸案例確認了
同一個共享佇列機制。診斷日誌為 `/tmp/storeweave-ticket120-diagnostic-9.log`。
完整 suite 現在執行雙 Reservation 案例，透過 `event_id` 分別核對目前案例的
`booking.reservation.paymentExpiring.v1` 工作與另一個 Reservation 的
`booking.reservation.cancelled.v1` 工作；兩者都是 `platform.event.deliver`。

回歸案例在通知儲存暫時失敗時，刻意排入另一個 Reservation 的取消事件，穩定得到
`failed: 2`；舊斷言先紅（`/tmp/storeweave-ticket120-red.log`）。修正後依各自的
`event_id` 查工作，驗證兩個事件各自失敗、目標事件重試後只建立一個通知請求，並
在終止情況保留 mapping failure 證據。工作嘗試次數只比較前後增加，不假設共享
drain 的重試時間或全域失敗總數。聚焦綠燈與整檔 66/66 分別記錄於
`/tmp/storeweave-ticket120-green.log`、`/tmp/storeweave-ticket120-booking-final.log`。
完整 `make verify` 通過：unit 1577/1577、admin 351/351、integration 1036/1036
（115/115 檔）；日誌為 `/tmp/storeweave-sw160-ticket120-verify-final.log`。

## 驗收

- [x] 在完整 suite 下辨認第二個 failed job 的類型、來源與 reservation/event identity。
- [x] 判斷是產品行為錯誤，還是測試把整輪 worker 結果當成本案例結果；依擁有邊界修正。
- [x] 加入能穩定重現原失敗的回歸驗證，且不掩蓋真正的通知失敗。
- [x] `make verify` 通過。

## 範圍

此票處理 Booking 通知測試／行為的失敗歸因；不屬於工單 119 的文件同步。
