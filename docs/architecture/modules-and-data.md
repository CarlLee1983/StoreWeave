---
description: 理解模組如何擁有資料、宣告相依、共用交易，以及 Extension 能使用哪些能力。
pageClass: architecture-page
---

# 模組邊界與資料責任

一個模組不只是幾個放在同一目錄的檔案。它要說清楚：**擁有什麼資料、對外提供什麼操作，以及需要其他模組提供什麼能力**。
這些宣告讓 Release 可以在啟動前檢查組合是否完整，也讓開發者知道一項規則應該改在哪裡。

本章先看組裝，再看執行期間的資料與呼叫邊界。前一章的事件是非同步協作；本章的 service 呼叫則可以在同一筆交易內完成。

## 啟動之前，先檢查這些模組能不能一起工作

模組宣告自己的 `name`、套件版本、相容的 Base 版本範圍、相依模組、能力 binding，以及資料表與 migration 的 ownership。
Runtime 先驗證整張模組圖，再建立 Database 與註冊 handler。

例如，一個模組要求某項能力，但 Release 沒有接上提供者，問題應該在啟動時被指出。
否則系統可能一直正常顯示首頁，直到有人執行特定操作才發現缺少服務。

這裡有三種不同的關係，不能全部當成「誰先啟動」：

- **靜態相依**決定固定的註冊順序。必要相依必須存在；可選相依若存在，也要符合版本條件。這種相依不能形成循環。
- **操作能力 binding**說明執行某項業務時會呼叫誰。組裝時驗證提供者、能力與版本，但不直接把這條邊當成初始化順序。
- **事件訂閱**表示事件送達後才執行工作。它不是同步初始化邊，不能因為兩個模組互相訂閱就判定啟動循環。

詳見 [ADR 0036](../adr/0036-validate-module-composition-before-runtime.md) 與[模組圖驗證實作](../../packages/platform/kernel/src/module-graph.ts)。

## 資料表由誰擁有，規則就由誰維護

每個模組擁有自己的資料表與 migration。其他模組要使用它的能力，應呼叫擁有者提供的 service 或資料投影，而不是直接修改對方的資料表。

以 Commerce 為例，訂單模組需要扣庫存，但「怎樣才算合法的庫存調整」由 Inventory 決定。
Order 透過 `inventoryService.adjust(ctx, ...)` 請 Inventory 執行調整，取得商品則透過 `catalogService.requireActiveProduct(tx, id)`。
呼叫端不需要複製庫存或商品有效性的判斷。

資料表前綴也能幫助定位擁有者：

- Commerce 使用 `cart_*`、`catalog_*`、`coupon_*`、`customer_*`、`inventory_*`、`invoice_*`、`loyalty_*`、`notification_*`、`order_*`、`promotion_*`、`refund_*`、`rma_*`、`shipping_*`。
- Booking 使用 `booking_*`；Dining 使用 `dining_reservation_*`。
- 品牌內容模組使用 `content_*`。
- 平台資料使用 `platform_*`。例如 identity 建立 `platform_users` 與 `platform_sessions`，不是 `identity_*`。

平台採共同前綴的理由是這些資料對產品領域中立。見 [ADR 0010](../adr/0010-platform-is-domain-agnostic.md)。實際 ownership 仍以模組與 migration 宣告為準，不能只靠字串前綴推斷。

## 跨模組操作，如何保持同一筆交易

模組邊界不等於資料庫交易邊界。Service 可以接受呼叫端提供的交易，讓幾個模組的操作一同提交或回滾。

例如，某個 handler 在同一筆交易中更新訂單與庫存。若庫存操作拒絕，不能留下「訂單變了、庫存沒變」的半套資料。
把交易傳給擁有資料的 service，可以同時保留模組規則與資料庫的原子性。

這與事件協作不同：事件訂閱者在原交易提交後才執行，因此訂閱者失敗不會回滾原交易。
需要同生共死的資料變更，不能只因為想解耦就隨意改成背景事件。

模組間共享交易的限制與驗證案例見 [ADR 0036](../adr/0036-validate-module-composition-before-runtime.md) 與[跨模組整合測試](../../tests/integration/module-consumers.test.ts)。

## 訂閱者也不能任意呼叫其他模組

Core subscriber 預設只能執行自己的 Command。若要執行別人的 Command，必須事先精確宣告 owner、名稱與 descriptor version，且與外部 owner 存在已驗證的相依或 binding。

這讓背景協作的依賴仍然可見。否則訂閱者雖然表面只宣告「我處理某事件」，實際卻可能偷偷要求一組未選入 Release 的模組。

這些都是受支援介面的組裝與授權約束，**不是惡意 Node 程式的安全沙箱**。受信任的程式仍可能自行 import SQL；模組圖檢查不能取代程式審查。見 [ADR 0036](../adr/0036-validate-module-composition-before-runtime.md)。

## Cache、Storage 與上傳入口怎麼取得

需要 Cache、Mutex 或 Storage 的模組，先在 `resources` 宣告需求，再透過 `bindResources` 取得資源。
Runtime 在 handler 執行前綁定一次，scope 的 namespace 固定由模組 id 推導；handler 不在執行期間任意換成另一個模組的 scope。

收檔案則使用 `uploads` 宣告入口名稱、允許的 content type 與收件 Command。通用入口是：

`POST /api/v1/modules/:module/uploads/:upload`

處理順序是先依收件 Command 的權限授權，再把位元組串流到該模組的私有 Storage scope，最後把 `storageObjectId` 與其他輸入交給收件 Command。
Command 失敗時，入口會嘗試刪除剛寫入的物件。這是補償操作，不是資料庫回滾；刪除失敗會記錄警告，程序中斷也可能留下物件。位元組本身不經過 CommandBus。

這種宣告讓新模組可以加入收檔能力，不必在共用 API 中另寫專屬 controller。使用配額仍由模組負責。
完整規則與範例見 [ADR 0050](../adr/0050-modules-declare-resources-and-upload-intakes.md)、[上傳入口與補償處理](../../apps/api/src/controllers/module-uploads.controller.ts)、[模組開發](../module-development.md) 與 [`file-requests`](../../packages/examples/file-requests)。

## Extension 與模組拿到的能力不同

Extension 使用 `ExtensionContext`，能取得 Command API、Query API、Job API、以 extension id 隔離的 Store，以及宣告過的 Provider 與 Secret。
它沒有 `tx` 或 `db`，因此不能把 Extension 寫成另一條直接改核心資料表的入口。

例如 ERP Extension 要讀訂單、安排推送工作，就透過這些公開能力完成。訂單狀態的修改仍由擁有業務規則的 Command 處理。
Extension 的開發契約見 [Extension 開發](../extension-development.md) 與 [Extension SDK](../../packages/platform/extension-sdk/src)。

## 為什麼有些服務不走 CommandBus

CommandBus 很適合需要授權、交易與冪等結果的寫入，但不能把所有服務都塞進去。

Booking Reservation 的匿名管理是一個例子：`BookingReservationAccess` 在交易中檢查管理憑證，只回傳 Reservation ID。
Access Grant 只能兌換管理憑證，不能直接執行管理操作。兌換走直接 service seam，因為 CommandBus 會將帶冪等鍵的回應保存到 `platform_idempotency`，不適合保存管理憑證的明文結果。
Reservation 保存的是 Grant generation、nonce、期限與 management credential hash。

這是刻意選擇的憑證邊界，不代表一般業務寫入可以繞過 CommandBus。相關領域名詞見[根目錄詞彙表](../../CONTEXT.md)。

## 接下來讀什麼

了解模組負責什麼之後，接著看[介面與後台資料流](interfaces-and-admin.md)，理解相同能力如何被網頁、API 與 CLI 使用。

[上一章：事件與背景工作](events-and-jobs.md) · [回到架構導讀](../architecture.md)
