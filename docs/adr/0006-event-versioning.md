# 0006. 事件版本與相容性政策

- 狀態：accepted
- 日期：2026-08-21（2026-08-24 補「一個 minor 週期」的前提，見〈後果〉）

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
  這條規則的前提是「有訂閱者可能還在舊版上」，而那要先有 release，見〈後果〉最後一段。
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

### 「一個 minor 週期」的前提：先要有 release（2026-08-24 補）

上面那條規則保護的是**已經在別人手上跑著的舊版**。沒有 release 就沒有那個人：
`.v1` 與 `.v2` 從來沒有一起出現在任何一個交付物裡，遷移期要保護的對象不存在。

因此規則展開成兩段：**一個 minor 週期從第一個 release 起算**；在那之前
（pre-1.0、`package.json` 仍是 `0.x`、`git tag` 是空的、且沒有任何實際部署），
舊版可以立即下線。這不是把規則放寬，是把它沒寫出來的前提寫出來。

第一次用到這個豁免是工單 24（2026-08-23）：`commerce.order.placed.v1` / `.v2` 與
`paid.v1` 在 `0.1.0`、零 tag、零部署的狀態下直接停發，因此 ADR 0017 那篇為過渡期
而寫的決定同時失效。記在這裡是因為後來的人讀到「舊版沒等一個週期就下線」會想把它
修回去，而該修的是這段前提沒寫出來，不是那次下線。

## Falsified if

`packages/platform/contracts/src/events.ts` 的 `EVENT_NAME_PATTERN` 被放寬到允許無版本後綴，
或 `packages/platform/event-bus/src/registry.ts` 的 `parse()` 不再於投遞前驗證 payload，
或出現必須破壞相容性又不能發新版本的情境，
或 `package.json` 的版本進入 `1.x`／`git tag` 出現第一個 release 之後仍有事件援引上述豁免
——最後一項成立時，「先要有 release」那段前提已經不再適用，立即下線的做法要收回。
