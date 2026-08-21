# 0006. 事件版本與相容性政策

- 狀態：accepted
- 日期：2026-08-21

## 背景

事件是 Core 與 Extension 之間最脆弱的介面：Core 升級時，客戶的 Extension 不一定同時更新。
如果事件 payload 可以隨意改，每次升級都會沉默地打斷某個客戶的整合。

## 決策

**版本寫進事件名稱**：`commerce.order.paid.v1`。格式由 `EVENT_NAME_PATTERN` 強制，
`defineEvent()` 會從名稱推出版本號，格式不對就在載入時拋錯。

相容性規則：

- **可以**在既有版本加入**選填**欄位。舊的訂閱者用 Zod schema 解析，多的欄位會被忽略。
- **不可以**移除欄位、改變欄位型別、或改變既有欄位的語意。要做這些事就發 `.v2`。
- 發 `.v2` 時，`.v1` 必須至少再保留一個 minor 版本週期，兩者同時發布，讓訂閱者有時間遷移。
- 訂閱未知事件名稱會在啟動時直接失敗（`EventBus.subscribe` 呼叫 `getEvent`），
  不會等到執行期才發現沒收到事件。
- Payload 在**發布時**與**投遞前**都會用 Zod 驗證：Core 不會送出不符契約的事件，
  Extension 也不會收到不符契約的資料。

Extension 用 `platformVersion` semver range 宣告它相容的平台版本；
`commerce doctor` 會列出每個 Extension 的相容性結論。

## 後果

- 客戶的 Extension 可以明確宣告「我吃 v1」，Core 升級到 v2 時不會沉默壞掉。
- `/api/v1/meta/events` 會輸出每個事件的 JSON Schema 與訂閱者清單，可以直接做為整合文件。
- 代價：同時維護多個版本會讓 `packages/commerce/*/src/events.ts` 變長；
  這是相容性的價格，而且它是顯性的。

## Falsified if

`packages/platform/contracts/src/events.ts` 的 `EVENT_NAME_PATTERN` 被放寬到允許無版本後綴，
或 `packages/platform/event-bus/src/registry.ts` 的 `parse()` 不再於投遞前驗證 payload，
或出現必須破壞相容性又不能發新版本的情境。
