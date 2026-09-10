# 0040. 通知是 Base 能力，模組以 bindPorts 取得它

- 狀態：accepted；B07 實作與整合測試通過。
- 日期：2026-09-09

通知從 Extension Provider（`notification` kind、`mock-notification`）改成永遠組裝的 `platform-notifications` 模組。理由是能力歸屬：一個沒有 commerce 的 base release 也要通知人，而收件人、模板、通道與投遞紀錄都與領域無關；反過來，Provider 那條路只有在剛好裝了某個 Extension 時才會送出通知，「沒裝就靜靜不通知」不是可運維的預設。舊的 provider kind 與 mock extension 一併刪除：留著它等於兩條投遞路徑，而重複投遞正是這裡最貴的錯誤。

收件人是平台帳號識別或一個 email 位址，不是 commerce Customer。`reference` 是冪等識別，內容快照與變數隨通知持久化，因此事件重播、job 重試與重複 command 都只會投遞一次，之後改模板也改不動排隊中的內容。通道各自一列投遞紀錄：`inapp` 在建立交易提交時就完成（收件匣那一列就是投遞），`email` 交給 B06 mail 的 job，因此一個通道退信不影響另一個。`mail.transport` 為 `disabled` 時 email 記成 `skipped` 且不排工作——沒有設定寄信管道是部署的決定，不是要無限重試的失敗。

模組在 runtime 存在之前就組裝完成，因此需要通知能力的模組以 `PlatformModule.bindPorts` 一次性接收 `PlatformPorts`，而不是查註冊表。這是既有 `BoundModuleCapability`／cache／storage binding 的同一種取捨的延伸：邊仍然看得見（模組宣告 `platform-notifications` 相依，`bindPorts` 是唯一入口），但它是組裝期的注入，不是 service locator，也不建立初始化順序邊。

商務端只保留「哪個事件用哪個模板通知誰」：`packages/commerce/notification` 的生命週期對應、coupon／loyalty 的模板、storefront 的重設密碼模板。它們不再各自記投遞狀態；`commerce.notification.listLifecycleDeliveries` 的狀態、attempts、`providerRef` 與錯誤都向 base 取，狀態因此多了 `skipped` 與 `unknown` 兩個舊 provider 表達不了的結果。B07 之前建立的紀錄沒有對應的 base 通知，維持顯示自己當時留下的欄位。

## Falsified if

`packages/platform/notifications/src/service.ts` 不再以 `reference` 保證單一投遞（`tests/integration/notifications.test.ts` 的重複 dispatch 與 `tests/integration/lifecycle-notifications.test.ts` 的重複 drain 會先失敗），或 `packages/platform/kernel/src/module.ts` 的 `bindPorts` 變成可以在 handler 執行期間重新取得、換掉的查詢介面，則重開本決策。若某個通道需要在建立交易內完成外部 I/O，或 `packages/commerce/notification/src/queries.ts` 為了效能改回自己存一份投遞狀態，通道獨立與單一事實來源這兩個前提就要重新論證。
