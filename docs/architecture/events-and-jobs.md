---
description: 從已付款事件到 ERP 推送，理解 Outbox、工作佇列、重試、去重與週期性排程的保證範圍。
pageClass: architecture-page
---

# 事件與背景工作

上一章把付款確認與待送事件一起寫入資料庫。本章接著追問：請求結束之後，誰把事件送出去？遇到程序中斷、外部服務失敗或重複投遞時，系統如何繼續工作？

StoreWeave 用 **Outbox 保留已發生的事實，用 Job 表達接下來要做的工作**。兩者都存在 PostgreSQL，由 Worker 推進；EventBus 本身負責事件目錄與訂閱登記，不是即時廣播器。

## 為什麼不在交易提交後直接呼叫訂閱者

假設先提交「訂單已付款」，再直接通知 ERP。若程序剛好在兩步之間停止，訂單雖然成功，通知卻沒有留下任何可恢復的紀錄。

Transactional Outbox 把這個缺口移到資料庫裡處理：付款結果與事件在同一筆交易中保存。提交之後，就算 API 程序停止，Worker 仍可從 Outbox 找出待處理事件。

這保證的是「應投遞的事件有紀錄」，不是「外部服務已完成處理」。兩者之間仍有佇列、重試與可能的失敗。
設計背景見 [ADR 0001](../adr/0001-modular-monolith.md) 與 [PostgreSQL 佇列的選擇](../adr/0035-retain-postgres-queue-for-modular-base.md)。

## Outbox 如何變成投遞工作

事件從 `platform_outbox` 進入 `platform_jobs`，再交給訂閱者。可以把它讀成三段：

**事件已保存 → 各訂閱者的工作已排入 → 訂閱者實際執行**

1. **取得一個事件。** `Worker.relayOutbox()` 使用 `claimOne` 與資料庫鎖協調處理，不讓多個 Worker 同時轉送同一筆紀錄。
2. **依發布時的訂閱快照建立工作。** 每個訂閱者取得一筆 `platform.event.deliver` job。去重鍵包含事件 id 與 subscriber id，形如 `evt:<outboxId>:<subscriberId>`。
3. **同一交易標記已轉送。** 所有應有的投遞工作落庫後，把事件設成 `relayed`。排入工作與更新旗標在同一筆交易內完成。

因此 `relayed` 的意思是「投遞工作已建立」，不是「ERP 已經收到」，也不是「所有訂閱者已完成」。
把這三種狀態混在一起，會讓監控畫面顯示成功，實際下游卻還在等待。

若事件或舊訂閱快照無法安全辨識，系統會隔離到 quarantine；一般轉送錯誤則記錄失敗並重試，達到次數上限後進入 dead。
實作見 [Worker 的 Outbox 轉送](../../packages/platform/kernel/src/worker.ts) 與 [Outbox 狀態處理](../../packages/platform/outbox/src/outbox.ts)。

## Worker 執行工作時，交易在哪裡

工作執行分成領取、執行、完成三步：

1. **Claim。** Worker 在資料庫中領取工作，取得這次執行的識別與 lease。
2. **執行 handler。** handler 在領取交易之外執行，可能呼叫外部 HTTP 服務。
3. **記錄結果。** 成功則完成工作；暫時失敗則依退避規則再排；永久失敗或耗盡重試次數則進入 dead。

Lease 是「這個 Worker 在一段期間內持有工作」的記錄。Heartbeat 延長有效持有，occurrence 與 claim token 則讓完成更新能核對是否仍是同一次有效執行。
若 Worker 消失，過期工作可以被回收，而不必永遠卡在執行中。

這些機制保護的是佇列狀態。舊 Worker 若已經送出 HTTP 請求，資料庫不能把遠端收到的請求收回，因此仍要考慮外部副作用重複的情況。
實作見 [Worker](../../packages/platform/kernel/src/worker.ts) 與 [JobQueue](../../packages/platform/jobs/src/jobs.ts)。

## 訂閱者收到的資料如何檢查

`platform.event.deliver` 在呼叫訂閱者前，會核對事件 descriptor、版本、訂閱者與 payload。Payload 以 Zod 驗證；無法安全投遞的事件會被隔離，不能靠不斷重試修好不相容的資料。

事件名稱帶有版本，例如 `commerce.order.paid.v2`。版本是公開契約的一部分，不只是方便閱讀的字尾。
改變 payload 語意時，必須同時考慮尚未投遞的舊事件與訂閱者相容性。

見 [事件投遞實作](../../packages/platform/kernel/src/event-delivery.ts) 與 [ADR 0006：事件版本](../adr/0006-event-versioning.md)。

## ERP 案例：去重有三層，但仍有條件

Demo ERP 訂閱已付款事件，再排一筆 `ext.demo-erp.push-order` 工作。該工作呼叫 `ErpProvider.push(doc)`，把文件送到外部 ERP。

這裡有幾個不同的防重複機制：

- **佇列去重鍵**避免同一事件對同一訂閱者重複建立一般投遞工作；ERP 推送工作也有自己的去重鍵。
- **本機投遞紀錄**讓已記為 `sent` 的文件可以被略過。
- **遠端的 reference 處理**決定同一份文件再次送到 ERP 時，遠端會回傳原結果，還是建立另一筆資料。

前兩層不能替第三層作保證。假設 ERP 已接收文件，但回應在途中遺失，本機就可能沒有寫下 `sent`。Job 重試時還是會再次送出。
要避免建立第二張單據，遠端必須正確處理同一個 reference；不能只因為本機有 dedupeKey，就宣稱跨系統「恰好一次」。

Demo ERP 的 HTTP client 明確保留這項限制。見 [ERP handler](../../packages/extensions/demo-erp/src/handlers.ts) 與 [ERP HTTP client](../../packages/extensions/demo-erp/src/erp-client.ts)。

### ERP 的 Store 與 Job 不共用核心交易

Extension 取得的是 SDK context，沒有 `tx` 或 `db`。SDK 的 `jobs.enqueue` 另外開啟交易，Store 也是獨立操作。
因此，ERP handler 中的排入工作、投遞紀錄與 snapshot 寫入，不能套用上一章核心 `ctx.tx` 的同交易保證。

ERP 的手動重送也不同於一般重試：它可以重新排入已完成或 dead 的工作，並把投遞紀錄改回 pending，可能再次產生外部副作用。
這是操作上需要理解的選擇，不能當成純粹刷新畫面。

依據：[ExtensionHost 的 SDK context](../../packages/platform/kernel/src/extension-host.ts)、[ERP handler](../../packages/extensions/demo-erp/src/handlers.ts)。

## 失敗之後，原本的訂單會怎樣

付款交易早已提交。後續 ERP job 失敗，只會進入那筆工作的重試或失敗處理，不會回頭撤銷已付款的事實。

但這不代表跨系統資料已經一致。訂單可能已付款，ERP 卻尚未同步；需要透過工作狀態、投遞紀錄與維運重試找出這段落差。
這就是非同步協作的取捨：前景流程不必等待每個下游，換來的是要明確管理「尚未完成」與「需要介入」的狀態。

平台死信佇列的維運能力見 [ADR 0011](../adr/0011-platform-ops-module.md)。

## 週期性工作：排程器只決定何時排入

單次 Job 表達「這項工作可在指定時間後執行」。週期性排程則反覆計算應有的 occurrence，再把每次 occurrence 轉成普通 Job。
Occurrence 可以理解為「某個排程在某個時點應有的一次執行」。

目前支援兩種互斥宣告：

- `everyMs`：用固定時間間隔計算執行時點。
- `cron` 與 `timezone`：依日曆規則與指定時區計算執行時點。

它們在啟動時驗證。Croner 只做日期計算，不在 API 或 Worker 程序裡另外啟動一組計時器。
真正執行仍交給 PostgreSQL JobQueue 與 Worker，這樣重試與狀態追蹤才走同一套流程。

### 停機、暫停與重疊如何處理

排程器用持久化 watermark 記住已處理到哪裡。停機後可以依 `catchUp` 的上限，取最近有限筆 occurrence 追補，並不是一律把歷史全部補跑。

暫停期間的 occurrence 會被跳過並推進進度，不會在解除暫停後全部變成待執行工作。
若採 `overlap: 'skip'`，已有進行中的工作時，新 occurrence 也會被跳過。

因此 cron 表達的時點是「應排入的時點」，不能保證 handler 精準在那一秒執行。Worker 輪詢、佇列等待與併發量都會影響實際開始時間。

以上是目前的排程行為。早期「只有 UTC 固定切片、停機不追補」的設計已由 [ADR 0039](../adr/0039-cron-calculation-only-croner.md) 修訂；[ADR 0016](../adr/0016-recurring-jobs-by-time-buckets.md) 保留歷史背景。現行來源是[排程宣告驗證](../../packages/platform/kernel/src/schedule-spec.ts)與[排程協調器](../../packages/platform/kernel/src/recurring.ts)。

## 接下來讀什麼

理解同步交易與非同步工作後，接著看[模組邊界與資料責任](modules-and-data.md)：哪些操作可以共用交易，哪些能力必須透過公開介面取得。

[上一章：一次請求如何讀寫資料](requests.md) · [回到架構導讀](../architecture.md)
