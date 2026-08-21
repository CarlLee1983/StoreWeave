# 0009. 非同步付款與庫存預留

- 狀態：accepted
- 日期：2026-08-21

## 背景

同步在 Command transaction 內呼叫金流會長時間持有資料庫連線，且 provider 已扣款但回應遺失時，訂單與金流結果可能不一致。同時，下單直接扣除 `on_hand` 使未付款訂單無法有明確的存貨生命週期。

## 決策

下單只增加 `inventory_stock.reserved`，以 `on_hand - reserved` 驗證可售量；訂單保留 15 分鐘。`payOrder` 將訂單轉為 `payment_processing`，並在同一交易排入 `commerce.order.process-payment`。Worker 在交易外呼叫 provider，成功後以具 idempotency key 的 `markPaid` Command 將預留轉為實體出庫、寫入付款資料、標記 paid 與寫入 `commerce.order.paid.v1` Outbox event。

下單時一併排入到期工作。到期工作與付款確認都鎖定同一張 Order，因此取消、到期與付款確認只能有一方完成狀態轉換；已成為 terminal state 的工作安全 no-op。到期狀態是新的 `expired`，不與人工 `cancelled` 混用。

`commerce.order.placed.v1` 持續發布一個 minor 週期；新增 `commerce.order.placed.v2` 明確描述預留與 `expiresAt`。

## 後果

- Storefront 在付款請求後立刻前往訂單頁，顯示付款處理中。
- Worker retry 依 provider reference 冪等，避免重複扣款。
- 若 provider 在 Order 到期後才確認成功，`markPaid` 會拒絕該轉換；這筆金流必須由後續真實金流 webhook／退款流程處理，不能靜默重新扣庫存。

## Falsified if

付款 provider 可證明在 Command transaction 中安全、低延遲且可原子確認，或庫存不再需要在付款前保留。
