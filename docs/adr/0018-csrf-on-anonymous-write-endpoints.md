# 0018. 強制匿名的寫入端點以 Origin 檢查代替 CSRF token

- 狀態：accepted
- 日期：2026-08-22

## 背景

工單 11 把 `@Public()` 的語意改成「不需要 token」，並用 `@Anonymous()` 標記
「一律當訪客」的端點。守衛的 CSRF 檢查綁在 session token 上（雙提交，值由 session
推導），因此**沒有 session 的端點沒有東西可以比對**。

而 Spec 0001 寫的是「前台的寫入端點受 CSRF 檢查」。目前掛著 `@Anonymous()` 的寫入
端點有五支：`POST /login`、`POST /register`、`POST /logout`、`POST /forgot-password`、
`POST /reset-password`（以及 API 端的 `/api/v1/auth/login`）。

其中登入不是無害的：攻擊者可以從外站送出自己的帳密，把受害者「登入成」攻擊者的帳號，
之後受害者填的收件地址、下的訂單全部進攻擊者的帳戶。`SameSite=Strict` 擋不住它——
那次請求本來就不需要帶 cookie，回應的 `Set-Cookie` 照樣會被存下來。

## 決策

**強制匿名的寫入端點改以 `Origin` 與 `Sec-Fetch-Site` 判斷同源，代替 CSRF token。**
兩個 header 都由瀏覽器自己加、前端偽造不了；兩者都不存在時（curl、伺服器對伺服器、
測試）放行，因為那些呼叫本來就不受 CSRF 影響。

**登出維持強制匿名，且刻意不受 CSRF 保護。** 被強制登出是干擾，不是資料外洩；而讓
登出需要 token 會使「session 已過期的人清不掉自己的 cookie」，那是一個更常見的壞狀態。

**有 session 的端點仍然走 CSRF token**（header 或表單欄位 `_csrf`），不受本 ADR 影響。

## 考慮過的選項

- **對登入頁發一顆 pre-session CSRF cookie。** 否決（暫時）：它要求登入頁一定是伺服器
  渲染且不能被快取，成本高於 Origin 檢查，而防護面幾乎相同。若之後前台改成 SPA 或
  加上 CDN 快取，這個選項要重新評估。
- **把登入也改成需要 session。** 不成立：身分在登入前不存在。
- **完全不管。** 否決：登入 CSRF 會讓受害者的個資寫進攻擊者的帳戶。

## 後果

- 極少數會送 `Origin` 但不同源的合法整合（例如另一個網域的登入表單）會被擋。這是刻意的。
- `Sec-Fetch-Site: cross-site` 的請求一律拒絕，包含從 email 連結 POST 的情境（不存在）。
- 後台帳號仍可走前台的密碼重設流程，但連結時效壓到 15 分鐘（顧客是 60 分鐘）：
  同一條流程，不同的暴露窗口。

## Falsified if

`apps/api/src/http/auth.ts` 的 `assertSameOrigin` 不再被 `@Anonymous()` 的路徑呼叫，
或 `POST /login` 開始接受跨站送出。
