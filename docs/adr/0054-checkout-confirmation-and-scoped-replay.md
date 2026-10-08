# 0054. Checkout 確認值與顧客範圍的重送

- 狀態：accepted
- 日期：2026-10-07

訂單能力契約要求顧客確認商品單價與運費，並讓不同顧客可以使用相同的識別鍵。
Command Bus 在 handler 前處理重送，因此只改 Order handler 無法滿足契約。
Bus 提供可選的 `idempotencyScope`、`idempotencyInput` 與 `transactionRetry` 宣告；
checkout 啟用它們，其他命令保留原本的範圍、完整輸入比對與單次交易。
這是共用產品的契約修正，不是店家或品牌差異。

本次確認值與顧客鍵範圍適用於 `commerce.order.checkoutCart` 及其 REST／Storefront 入口。
本次決策時的 `commerce.order.placeOrder`／`POST /api/v1/orders` 是較早的顧客直接下單介面，
當時依自己的輸入契約成立，沒有配送輸入，也未提供顧客確認的單價。
共同的逐筆拒絕、庫存保留與安全錯誤訊息仍由同一個 Order 邊界處理。
直接下單後續由 [ADR 0055](0055-direct-order-confirmation-and-legacy-keys.md) 與 SW-185／SW-186／SW-187 補齊宅配確認及舊鍵防重複；本次購物車情境證據仍不能推廣為所有訂單介面的保證。

## 決策

- checkout 識別鍵依已驗證 Actor 隔離。Customer 的帳號 Actor 唯一，不能由輸入冒用。
  儲存名稱使用 command 名稱與 Actor ID 的 JSON tuple；公開 command 名稱不得以 `[` 開頭，
  防止一般命令與內部名稱碰撞。仍比對儲存的 Actor，保留第二層保護。
- 重送比對保留購物車、確認的商品單價與正規化後的收件資訊等交易輸入；
  只有確認的運費不參與比對。運費只在首次成立時檢查。
  不同鍵對同一台已結帳購物車仍由購物車鎖與 `orderId` 回傳原訂單（ADR 0022）。
- 結帳先依商品 ID 排序取得 Catalog 商品的共享列鎖，再預留庫存；配送方法的共享列鎖
  在計算成立運費時取得，均持有到交易完成。商家更新等待訂單交易完成，
  並行顧客可共享商品與配送鎖；一般預覽查詢不取鎖。
- 可修正的拒絕回報所有問題明細與現行價格，不揭露確切可售量。
  拒絕以 validation details 表達，整個交易回滾，不保存識別鍵、訂單或部分保留。
- 只在已知可安全重開交易的情況重試：PostgreSQL deadlock／serialization failure，
  或預留失敗且交易內診斷無法確認不足。每次沿用原鍵，最多三次。
  用盡後回報「暫時無法處理，請以原識別鍵重試」。不自動重試未知的連線或 commit 結果。

## 取捨與回滾

Order 自建冪等表或繞過 Bus 會複製授權、交易與並行重送的機制，故不採用。
這些宣告不要求資料表 migration，也不改其他冪等命令。
舊的 checkout 快取列保留；升級後，符合新 DTO 的請求由購物車 `orderId` 找到舊訂單。
原封不動重送缺少確認欄位的舊請求會先被 validation 拒絕；客戶端必須更新確認輸入，
不能將購物車 fallback 解讀為舊請求格式相容。API 與客戶端表單應一起升級。
回滾也保留新列與訂單，以購物車的交易鎖防止重複成立。
因舊版 strict DTO 不接受確認欄位，應同步回滾 checkout 的 API、表單與 Theme。

## Falsified if

`packages/platform/command-bus/src/command-bus.ts` 對未宣告的命令套用新範圍或重試、
`packages/commerce/order/src/commands.ts` 不再檢查購物車歸屬與既有 `orderId`，
或 checkout 重送比對開始包含確認的運費，任一條成立就必須重新評估本決策。
