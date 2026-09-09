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

## HTTP

`/api/v1/auth` 是身分的全部入口，base 與 commerce 共用同一份 controller：

| 端點 | 用途 |
| --- | --- |
| `POST /login` · `/logout` · `GET /me` | 登入、登出、看自己；登入接受 `mfaCode` 或 `recoveryCode` |
| `POST /register` | 自助註冊，角色由 release 目錄的 `selfServiceRegistration` 決定 |
| `POST /forgot-password` · `/reset-password` | 中性回應；連結來自信件 |
| `POST /verify-email` · `/resend-verification` | 信箱驗證 |
| `POST /change-email` · `/confirm-email-change` | 換信箱：要現有密碼，確認信只寄到新地址 |
| `POST /change-password` · `/revoke-other-sessions` | 改密碼、登出其他裝置 |
| `GET /mfa` · `POST /mfa/enroll` · `/mfa/confirm` · `/mfa/recovery-codes` · `/mfa/disable` | 第二因素 |

CLI：`user:create`、`token:create` / `token:list` / `token:revoke`。

## 安全性質

- 帳號枚舉：登入、註冊、忘記密碼、換信箱衝突全部使用同一組中性訊息；帳號不存在時
  仍跑一次完整 scrypt，兩條路徑的耗時不可分辨。
- 重放：身分連結由 `used_at` 的原子 UPDATE 消費；TOTP 由 `last_time_step` 擋；
  API token 由 `revoked_at` / `expires_at` 擋。
- 停用與降權在下一個請求就生效：session 不快取權限，角色每次重讀。
- 暴力嘗試：帳號層十次失敗鎖十五分鐘（含第二因素的失敗），來源層沿用 HTTP 限流。
