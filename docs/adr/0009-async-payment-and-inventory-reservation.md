# 0009. 非同步付款與庫存預留

- 狀態：accepted
- 更新（2026-08-25，工單 75）：文中作為進入點的 `markPaid` command 已移除——它沒有任何
  呼叫端，付款結果一律經 `recordPaymentResult` 進來，實際的轉換由 module 內部的
  `markOrderPaid` 執行。決定（非同步付款 + 庫存預留）不變，只有進入點的名字換了。
- 日期：2026-08-21

## 背景

同步在 Command transaction 內呼叫金流會長時間持有資料庫連線，且 provider 已扣款但回應遺失時，訂單與金流結果可能不一致。同時，下單直接扣除 `on_hand` 使未付款訂單無法有明確的存貨生命週期。

## 決策

下單只增加 `inventory_stock.reserved`，以 `on_hand - reserved` 驗證可售量；訂單保留 15 分鐘。`payOrder` 將訂單轉為 `payment_processing`，並在同一交易排入 `commerce.order.process-payment`。Worker 在交易外呼叫 provider，成功後以具 idempotency key 的 `markPaid` Command 將預留轉為實體出庫、寫入付款資料、標記 paid 與寫入 `commerce.order.paid.v1` Outbox event。

下單時一併排入到期工作。到期工作與付款確認都鎖定同一張 Order，因此取消、到期與付款確認只能有一方完成狀態轉換；已成為 terminal state 的工作安全 no-op。到期狀態是新的 `expired`，不與人工 `cancelled` 混用。

`commerce.order.placed.v1` 持續發布一個 minor 週期；新增 `commerce.order.placed.v2` 明確描述預留與 `expiresAt`。

## 補充（2026-08-22）：Cart 不預留庫存

引入 Cart 之後，預留的起點仍然是 `placeOrder`，不是加入購物車。放進 Cart 不保證買得到，
可售量的驗證與失敗都發生在結帳當下。

理由有兩層。其一，Cart 預留會讓 `on_hand - reserved` 被無人結帳的殭屍購物車吃光，
而購物車的滯留時間以天計、訂單的預留以 15 分鐘計，兩者不能共用同一個計數器。
其二，`inventory_stock` 目前只有 product 層級的 `on_hand` / `reserved` 兩個計數器，
沒有 reservation 明細表；訂單與預留之間唯一的關聯是寫進 `inventory_movements.reference`
的訂單號。要支援 Cart 層級的預留（能查、能部分釋放、能設不同期限），必須先把 inventory
改成有明細的 reservation 模型 —— 那是獨立的一批工作，不因為 Cart 落地而順便發生。

## 補充（2026-08-24）：時間尺度與入口由 ADR 0030 擴充

接上真實金流之後，這篇的兩個前提各被放寬一次：付款不再一定是秒級的
（非即時付款以天計），付清也不再一定經過金流商（代收貨款由物流的取貨回報造成）。
新增狀態 `awaiting_payment`、`markPaid` 前置放寬、預留期限參數化，
都記在 ADR 0030。

這篇的形狀不變：`payOrder` 仍然不在交易內呼叫 provider，
庫存仍然以 `on_hand - reserved` 驗證可售量，到期工作仍然是一單一支、
與付款確認鎖同一張 Order。下面的「Falsified if」因此照舊成立。

## 後果

- Storefront 在付款請求後立刻前往訂單頁，顯示付款處理中。
- Worker retry 依 provider reference 冪等，避免重複扣款。
- 若 provider 在 Order 到期後才確認成功，`markPaid` 會拒絕該轉換；這筆金流必須由後續真實金流 webhook／退款流程處理，不能靜默重新扣庫存。

## Falsified if

`packages/commerce/order/src/commands.ts` 的 `payOrder` 不再把訂單轉為 `payment_processing`
而是在交易內直接呼叫 provider，或 `packages/commerce/inventory/src/service.ts`
不再以 `on_hand - reserved` 驗證可售量而是下單即扣 `on_hand`。

前者代表付款 provider 已可證明在 Command transaction 中安全、低延遲且可原子確認，
後者代表庫存不再需要在付款前保留 —— 兩者任一成立，這個決策的前提就不在了。
