# 0020. Core 模組可以訂閱其他模組的事件

- 狀態：accepted
- 日期：2026-08-22

## 背景

工單 34 要的是「新會員一註冊就發一張券」，而 Spec 0004 同時要求
「發券失敗不影響註冊成功」。這兩件事合起來排除了最直覺的做法——
在 `registerCustomer` 的交易裡直接發券，因為那樣發券失敗會讓註冊一起回滾。

事件投遞的機制早就存在（Outbox + 背景工作 + `EventBus.subscribe`），
但訂閱者只有 Extension 走得進去：`PlatformModule` 沒有宣告訂閱的地方，
而 `EventHandlerContext` 只有 `logger` 與 `correlationId`，沒有任何寫入資料的途徑。

## 決策

`PlatformModule` 新增 `subscribers`，訂閱者識別就是模組名稱；
`EventHandlerContext` 新增選填的 `executeCommand`，由 Worker 從 JobContext 傳下去
（它本來就掛在那裡，只是沒往下傳）。

Extension **不會**拿到 `executeCommand`：它們走 SDK，不該有一條直達 Command Bus 的捷徑。
這是 ADR 0005 的資料所有權規則的延伸——Core 模組彼此是同一個信任邊界內的鄰居，
Extension 不是。

## 考慮過的選項

- **在 `registerCustomer` 裡直接發券。** 否決：違反「發券失敗不影響註冊成功」。
- **註冊時排一個背景工作（`ctx.enqueue`），不發事件。** 這其實可行，
  而且不需要動任何平台契約。否決的理由是它只解決這一次：下一個要對註冊做出反應的
  功能（歡迎信、CRM 同步、風控名單）會再排一個工作，而「誰對註冊有興趣」
  這件事就散在 customer 模組的 handler 裡。事件把這個關係倒過來——
  由關心的人自己訂閱。
- **讓 Core 模組共用 Extension 的 SDK。** 否決：SDK 刻意不給資料層存取，
  而 Core 模組本來就有；為了共用一個入口而繞遠路，只會讓兩邊都變形。

## 後果

- 事件投遞跑在交易外，因此訂閱者的副作用與發出事件的那筆交易**分開成敗**。
  「發券失敗不影響註冊成功」是這個機制的結果，不是額外的處理。
- 重複投遞是常態（工作會重試），因此訂閱者的副作用必須自己冪等。
  發券靠資料庫的唯一索引 `issue_key` 擋下第二張——不是靠先查一次。
- `executeCommand` 以 system 身分執行，因此訂閱者拿得到的權限比任何使用者都大。
  這是刻意的：它們代表的是系統自己的反應，不是某個人的請求。

## Falsified if

`packages/platform/kernel/src/module.ts` 的 `PlatformModule` 不再有 `subscribers`、
或 `packages/platform/contracts/src/descriptors.ts` 的 `EventHandlerContext`
不再帶 `executeCommand`、或 `packages/platform/kernel/src/event-delivery.ts`
不再把它往下傳 —— 任一項成立，代表 Core 模組換了別的方式對事件做出反應，
這篇記的理由要重新檢視。
