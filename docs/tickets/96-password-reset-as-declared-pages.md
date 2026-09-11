# 96 — 忘記密碼與重設密碼走模組宣告的頁面

**What to build:** 忘記密碼的人在前台送出信箱、收到連結、設定新密碼、被帶到登入頁——四條路由從 controller 搬到模組宣告的頁面，行為一字不改。

**Blocked by:** 94

**Status:** done

- [x] 忘記密碼與重設密碼的 GET／POST 由模組宣告，controller 上對應的 decorator 刪除
- [x] 忘記密碼不論信箱存不存在都回同一句中性訊息，失敗只記 log
- [x] 重設成功後轉到登入頁；token 無效時的訊息與狀態碼不變
- [x] 兩者的節流行為不變——忘記密碼沒有節流就是免費的寄信轟炸器

## 邊界

和 95 改的是不同頁面，可以並行；共用的模組骨架在 94 就位了。

## 實作落點

這一票沒有自己的 commit：四頁與 95 的註冊頁一起落在 `5247e27`（工單 95），檔案是
`packages/platform/auth/src/pages.ts`。逐項與舊 decorator（`5247e27^` 的
`storefront.controller.ts`）比對過：中性訊息是同一個字串、寄信失敗只走 log、重設成功
303 轉 `/login`、token 無效仍是 400 加同一句 fallback、兩個 POST 都維持
`rateLimit: 'auth'`。

一處與「行為一字不改」不符，記在這裡而不是讓它無聲消失：舊的四條路由掛
`@Anonymous()`（強制匿名），新的資料驅動路由沒有 per-page 強制匿名，所以這四頁
變成 session-or-anonymous。這是 ADR 0047「連帶的行為變更」那一段描述的同一件事——
那段只點名登入與登出，實際上忘記密碼與重設密碼也一起變了。
