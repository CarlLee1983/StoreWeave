# 0042. 身分連結一律簽發，簽章金鑰因此是必要設定

- 狀態：accepted；B08 片1 實作，整合與單元回歸通過。
- 日期：2026-09-09

密碼重設、信箱驗證與信箱變更的連結改用 ADR 0038 的 `sw1.` 格式，purpose 分別是
`identity-password-reset`、`identity-email-verification`、`identity-email-change`。
`platform_identity_tokens` 的一列不再存任何秘密：偽造由簽章擋，重放由 `used_at` 擋，
兩者的證據來源不同，外洩資料庫不等於可以接管帳號。

代價是 `security.signingKeys` 從選配變成每個部署都要有。`packages/platform/kernel/src/runtime.ts`
在組裝 `AuthService` 時 `requireKeyring`，所以沒有金鑰的部署啟動就失敗，而不是安靜地
上線之後在某個使用者按下「忘記密碼」時才炸。這與 B09 的下載連結原本「乾淨的 base
release 不需要簽章能力」的假設相反——那個假設在密碼重設也走簽發值之後不再成立：
一個不能重設密碼的商店不是精簡設定，是壞掉的部署。

沒有沿用舊的「隨機 token + 存 sha256」有兩個理由。其一是 ADR 0038 已經指名 B08 的
連結採同一格式，各自實作會讓兩套到期與輪替語意並存。其二是舊法的作廢手段只有
UPDATE 一張表；簽發值可以靠移除 key id 一次作廢某把金鑰簽過的全部連結，這在
「金鑰疑似外洩」時是唯一夠快的手段。

`platform_password_resets` 直接刪除，不做資料搬遷。舊表存的是雜湊，沒有對應的新形式
可以生成；未使用的重設連結壽命最長一小時，遷移成本是「請再按一次忘記密碼」。

暫存的新信箱以 `swe1.` 封裝（purpose `identity-token-data`）。它是尚未驗證的個人資料，
在資料庫裡是明文的話，一個唯讀的備份就等於一份「誰正在換到哪個信箱」的清單。

## Falsified if

`packages/platform/identity/src/tokens.ts` 不再以 `signValue` 產出連結（改回自存雜湊），
或 `packages/platform/kernel/src/runtime.ts` 建立 `AuthService` 時不再 `requireKeyring`
而讓沒有金鑰的部署啟動成功，或 `packages/platform/kernel/src/health.ts` 不再把
`security.signingKeys` 的 `secretRef` 列入 `requiredSecrets`；任一成立表示部署可以在
沒有簽章能力的狀態下上線，重設連結的偽造防護與整批作廢手段同時消失，須重開本決策。
