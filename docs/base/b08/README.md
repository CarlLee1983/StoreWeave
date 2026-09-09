# B08 — Identity 與安全閉環

`@storeweave/identity` 從「帳號 + session + 密碼重設」擴張成 base 的完整身分能力：
一個 base-only release 可以自助註冊、驗證信箱、換信箱、重設密碼、管理自己的 session，
而且完全不需要 commerce 的 Customer。Customer 仍由 commerce 擴充，不是身分的前提。

本包不新增 workspace package。identity 已經是 `platform-identity` 模組，
新增的能力是它的檔案與 migration，不是第二套身分系統。

## 邊界

- **帳號是 base 的，Customer 是 commerce 的。** base 角色目錄新增可自助註冊的
  `member`；`commerce.customer.registerCustomer` 維持既有語意，仍在同一交易建立
  `platform_users` 與 `commerce_customers`。兩者不是同一個生命週期，見 ADR 0041。
- **離開行程的身分連結一律是 ADR 0038 的 `sw1.` 簽章值**：密碼重設、信箱驗證、
  信箱變更共用一種格式，purpose 不同。簽章證明沒被偽造，DB 的一列證明沒被重放。
  identity 因此在啟動時要求 `security.signingKeys`，見 ADR 0042。
- **身分自己寄信，走 `@storeweave/mail`。** 重設信與驗證信不再經 `NotificationProvider`
  extension：base release 沒有那個 provider，而重設信是 base 的能力。
- **Service token 存在資料庫，可到期可撤銷**，由 CLI 簽發，`auth.tokens` 設定移除，
  見 ADR 0043。
- **MFA 用成熟實作**（TOTP + 一次性復原碼），對 `account.mfa: 'required'` 的角色強制，
  見 ADR 0044。

## 契約

- `identity.tokens` 是一張表、三種 purpose、一種格式。token 建立與寄信 enqueue 在
  **同一個交易**：不會出現「信寄出去了但 token 沒存」或反過來。
- 重設與驗證的失敗一律不區分「沒這個帳號」與「token 不對」。回應中性，
  timing 由既有的 `DUMMY_HASH` 路徑保證。
- session 不快取權限：降權在下一個請求就生效。停用帳號同時撤銷所有 session。
- 過期的 token 與 session 由排程清理，不靠人工。

## 驗證

見 `acceptance.md`。
