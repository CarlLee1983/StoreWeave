# 0044. 後台帳號的第二因素是 TOTP＋一次性復原碼

- 狀態：accepted；B08 片4 實作，整合回歸通過。
- 日期：2026-09-09

`account.mfa: 'required'` 的角色（base 與 commerce 的 admin／staff／readonly）登入時要出示
第二因素。TOTP 用 `otplib` 13，秘密以 `swe1.` 封裝在 `platform_user_mfa`；復原碼是十組
128 bit 隨機值，只存 sha256，用掉一組不影響其他組。spec 0009 已經定調「採現成實作，
不能以自製密碼學補足」，這裡選 otplib 是因為它把 base32、HMAC 與驗證窗口都做完了，
而我們要寫的只剩「這一組用過了沒有」。

三個不那麼明顯的決定：

**未確認的註冊不生效。** `beginEnrolment` 寫入秘密但 `confirmed_at` 是 NULL，要成功送出
一組代碼才啟用。相反的做法——寫入就啟用——會讓掃描 QR 失敗的人立刻被鎖在自己的
後台外面，而那正是最需要能登入的時刻。

**沒有註冊的必要帳號仍然登得進來，但被標記。** `authenticate` 回傳 `mfaEnrolmentRequired`
而不是拒絕。第一個管理員是用 CLI 建的，他必須先登入才設定得了 TOTP；把這一步做成硬性
拒絕等於讓全新部署無法完成初始化。強制發生在 UI 層（B13）而不是認證層，代價是
「已建立但未設定」的窗口存在，補償是這個狀態在每次登入回應裡都看得見。

**用過的時間步會留下。** `last_time_step` 配合 otplib 的 `afterTimeStep`，讓同一組六位數在
它的三十秒窗口內只能用一次，而且更新寫成帶條件的 UPDATE，所以兩個同時抵達的請求
只有一個算通過。沒有這一段，看得到螢幕或攔得到請求的人可以在同一個窗口內重放。

復原碼用 sha256 而不是 scrypt：它們是 128 bit 的隨機值，沒有可猜的結構，慢雜湊擋不到
任何攻擊，只會讓「依序比對十組」變成一秒。密碼走 scrypt 的理由在這裡不成立。

關閉第二因素要密碼加一組有效代碼，而且會撤銷其他所有 session——降低安全等級的動作
不能只憑一個被借走的瀏覽器完成。

## Falsified if

`packages/platform/identity/src/mfa.ts` 不再以 `otplib` 驗證（改為自寫 HMAC/base32），
或 `beginEnrolment` 寫入時就設定 `confirmed_at`，或 `verifyForLogin` 不再以
`afterTimeStep` 與帶條件的 `last_time_step` UPDATE 擋重放，或
`packages/platform/identity/src/migrations.ts` 讓 `platform_user_mfa.secret` 以明文落地；
任一成立表示第二因素要嘛不是成熟實作、要嘛擋不住重放、要嘛會把人鎖在門外，須重開本決策。
