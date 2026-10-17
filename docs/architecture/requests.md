---
description: 跟著一次付款請求，理解 Actor、CommandBus、QueryBus、交易與冪等保護的責任。
pageClass: architecture-page
---

# 一次請求如何讀寫資料

StoreWeave 把「如何接收請求」與「如何執行業務」分開。HTTP Controller 把請求轉成 Command 或 Query；Bus 處理共用檢查，handler 才執行特定產品的規則。

本章以 Commerce 的付款為例。先記住一個差別：**接受付款請求，不等於已確認收到款項。** 一般付款要經過背景工作與金流回應，才會得到最後結果。

## 先分清楚 Actor、Command 與 Query

**Actor** 是這次操作使用的身分與權限脈絡。它可以代表顧客、後台操作者或系統服務；Account 是可登入的帳號，Session 是一次登入的持續狀態，三者不能混用。

**Command** 表達要執行的寫入意圖，例如「為訂單發起付款」。Command 的 descriptor 宣告名稱、權限、輸入與輸出 schema，以及冪等要求；handler 實作業務行為。

**Query** 表達要取得的資料，例如讀取訂單狀態。它也有權限和輸入／輸出契約，但不套用 CommandBus 的寫入交易與重送流程。

名稱與定義見[根目錄詞彙表](../../CONTEXT.md)；共用執行入口分別是 [CommandBus](../../packages/platform/command-bus/src/command-bus.ts) 與 [QueryBus](../../packages/platform/query-bus/src/query-bus.ts)。

## 從 HTTP 到 handler，誰負責哪一步

以 `POST /api/v1/orders/:id/pay` 為例，主要路徑是：

**HTTP 身分解析 → Controller → CommandBus → 業務 handler → 提交結果**

1. **解析身分。** Bearer token 路徑由 `ApiTokenGuard` 查詢 `platform_api_tokens`，取得 Actor 與權限。Token 由 CLI 簽發，可以到期或撤銷。這是 token 呼叫的例子，不能推論所有前台頁面都使用 Bearer token；瀏覽器也有 Session 路徑。
2. **轉換請求。** Controller 把輸入交給 `commands.execute('commerce.order.payOrder', input, options)`。Controller 不在這裡另寫一套付款規則。
3. **檢查權限與輸入。** CommandBus 依 descriptor 檢查權限，Policy 可以進一步否決；Zod 驗證輸入形狀。輸入錯誤會形成 `VALIDATION_ERROR`，不是把它當成伺服器故障。
4. **建立受保護的執行範圍。** Bus 檢查冪等要求，開啟資料庫交易，處理既有結果或執行 handler。
5. **驗證與提交。** handler 回傳後，Bus 驗證輸出，保存適用的冪等結果，再提交交易。HTTP 層將結果轉為回應。

Token 的生命週期見 [ADR 0043](../adr/0043-api-tokens-live-in-the-database.md)。Bus 的執行順序見 [CommandBus 實作](../../packages/platform/command-bus/src/command-bus.ts)。

## 交易保證涵蓋哪些事情

核心 Command handler 使用 `ctx.tx` 修改資料；`ctx.publish()` 把事件寫進 Outbox，`ctx.enqueue()` 排入工作，Audit 與冪等結果也在同一筆交易中記錄。
這些資料庫變更一起提交，或一起回滾。連輸出 schema 驗證失敗，都不能留下已提交的半套結果。

因此，handler 不必先完成資料變更，再冒著程序中斷的風險另外發送事件。它可以在資料改變的同一筆交易內留下「之後必須投遞」的紀錄。
下一章會說明 [Outbox 如何轉成背景工作](events-and-jobs.md)。

這個保證有明確範圍：**資料庫回滾不能撤銷已送往外部服務的請求。** Extension SDK 的 Store／Job 操作也不是自動加入核心 Command 的 `ctx.tx`。
不能把整條包含 HTTP、Extension 與資料庫的流程都畫在同一個原子交易框內。相關實作見 [CommandBus](../../packages/platform/command-bus/src/command-bus.ts) 與 [ExtensionHost](../../packages/platform/kernel/src/extension-host.ts)。

## 同一個請求重送，為什麼不應重新做一次

假設使用者送出付款請求後網路中斷。畫面沒收到結果，不代表伺服器沒收到請求。如果重新產生一個新操作直接送出，就可能重複執行。

冪等鍵讓呼叫端把「同一次意圖的重送」與「另一個新操作」區分開來。對要求 `idempotency: 'required'` 的 Command，缺少 key 會被拒絕。

能否回放既有結果，還要核對 Command namespace、key、payload hash 與 Actor。不能拿同一把 key 換一份輸入，也不能因為猜到別人的 key 就取得別人的結果。
Actor 是否成為 key 的分區，由 descriptor 宣告；不是所有 Command 都使用完全相同的 scope。

併發請求透過資料庫唯一索引協調。同一個 key 的第二個請求會等待第一個交易結束，再依記錄判斷回放或拒絕，而不是兩個 handler 同時各做一遍。
這是對特定操作與資料庫紀錄的保護，不是對任意外部副作用的「恰好一次」保證。

### 授權與歷史 key 的額外限制

某些 Command 宣告 `requiresBeforeIdempotency`，要求呼叫端提供交易內的授權 guard。它必須在讀取冪等快取前重新驗權，避免憑證已撤銷卻仍能取回舊結果。

宣告 `legacyIdempotencyGuard` 的 required、Actor-scoped Command 會在交易內檢查舊鍵，先核對 Actor，再檢查 hash／狀態並拒絕不適用的歷史成功鍵。
這是在 scope 改變後防止重複建立的相容性限制，不是日常所有 Command 都要執行的步驟。

實作見 [CommandBus](../../packages/platform/command-bus/src/command-bus.ts)；Checkout 的確認值與有限交易重試見 [ADR 0054](../adr/0054-checkout-confirmation-and-scoped-replay.md)，直接下單與歷史 key 的部署／回滾限制見 [ADR 0055](../adr/0055-direct-order-confirmation-and-legacy-keys.md)。

## 付款案例：兩段交易，中間才呼叫金流

一般非零金額的付款，不會在最初的 HTTP 交易裡等金流完成。

### 第一段：接受付款意圖

`payOrder` 建立新的付款嘗試，把訂單設成 `payment_processing`，並排入處理付款的背景工作。
這些資料隨第一段 Command 交易一起提交。

此時可以說「付款請求已接受」，不能說「訂單已付款」。同一張訂單可能有多次付款嘗試，每次都有自己的識別與狀態。
0 元訂單是例外：它可以使用內部付款嘗試同步完成，不需要等待外部金流。

### 中間：Worker 呼叫 Provider

付款 job 在交易外呼叫 Payment Provider。這讓外部網路等待與資料庫交易分開。
取得結果後，再由系統執行 `recordPaymentResult`，而不是讓 Provider 直接改訂單資料表。

付款方式若要顧客稍後繳款，訂單可以進入 `awaiting_payment`。取得繳費資訊仍然不是付款成功；狀態與期限的規則見 [ADR 0030](../adr/0030-awaiting-payment-and-variable-reservation.md)。

### 第二段：記錄付款結果

確認成功後，`markOrderPaid` 在 Command 交易內完成預留庫存的處理、付款與訂單狀態、相關回饋與會員累計，並發布 `commerce.order.paid.v2`。
這時「資料庫中已付款的事實」與「待投遞的已付款事件」一起提交。

如果 ERP 之後暫時不可用，不能據此把付款改回失敗。ERP 同步是另一段有自己重試與失敗狀態的工作。

目前程式依據是[訂單 Command 與付款工作](../../packages/commerce/order/src/commands.ts)中的 `payOrder`、`recordPaymentResult`、`markOrderPaid` 與 付款 job。設計背景見 [ADR 0009](../adr/0009-async-payment-and-inventory-reservation.md)；該 ADR 的歷史正文仍保留部分舊名稱，閱讀目前入口時以程式與開頭更新為準。

## 讀取資料時，QueryBus 做什麼

QueryBus 的主要順序比較短：**授權 → 輸入驗證 → handler → 輸出驗證**。
它把 `ctx.db` 提供給 handler，沒有額外套上 CommandBus 的交易、Audit、Outbox 與冪等流程。

例如畫面想知道訂單現在是 `payment_processing` 還是 `paid`，就讀取目前資料；這個讀取不應因為畫面重新整理而再發起付款。
讀取與寫入分開後，介面可以反覆取得狀態，而把有副作用的行為保留給明確的 Command。

QueryBus 是應用程式介面上的讀取路徑，不是會攔截任意 SQL 的唯讀安全沙箱。實作見 [QueryBus](../../packages/platform/query-bus/src/query-bus.ts)。

## 接下來讀什麼

付款已確認之後，如何把事件送到 ERP？接著讀[事件與背景工作](events-and-jobs.md)。

[上一章：平台、產品與 Release](platform-and-products.md) · [回到架構導讀](../architecture.md)
