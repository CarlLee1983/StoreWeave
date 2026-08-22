# 0023. Cookie 名字帶 `__Host-` 前綴，前綴的有無由部署的協定決定

- 狀態：accepted
- 日期：2026-08-22

## 背景

四張 cookie（`commerce_session`、`commerce_csrf`、`commerce_cart`、
`commerce_cart_notice`）原本都是固定的裸名。裸名的 cookie 有一個瀏覽器層面的弱點：
同一個註冊網域下的任何子網域都寫得出它們。`evil.shop.example.com` 可以替
`shop.example.com` 寫一張 `commerce_session`，把受害者接下來的操作導進攻擊者的帳號
（session fixation），或替換掉他的訪客購物車。SameSite 與 HttpOnly 都擋不住這件事——
那張 cookie 是同站寫入的，而寫的人不需要讀。

`__Host-` 前綴是瀏覽器強制的解法，代價是三個必要條件：`Secure`、`Path=/`、
**沒有** `Domain`。後兩者本來就成立，`Secure` 則是本機以 http 開發時唯一拿不到的那一個。
工單清單裡「cookie 沒有 `__Host-` 前綴」這一項擱置至今，擋住的就是這個。

## 決策

**名字跟著 Secure 一起決定**：發得出 `Secure` 就用 `__Host-` 前綴名，發不出就用裸名。
判斷沿用既有的 `secureCookies(publicUrl)`——https，或非本機的 hostname（TLS 由反向
代理終止的情況）。單一入口在 `apps/api/src/http/cookie-names.ts`：寫入走 `hostCookie()`，
讀取走 `readCookie()`。

**名字與屬性由同一個函式產出**，呼叫端只給得起 `httpOnly` / `sameSite` / `maxAge`。
分成兩個各自獨立的決定就會走鐘——名字帶了前綴而 `secure` 是 false，或有人補上 `domain`——
三種寫法型別都過得了，瀏覽器卻會靜默丟掉整張 cookie，而 `app.inject()` 不模擬瀏覽器的
接受規則，測試也照樣全綠。四張 cookie 的基底名收成 `CookieBase` 聯集，因此「寫的名字和
讀的名字不一致」是編譯期問題。

兩個附帶決定：

- **讀取不回退到裸名。** 回退等於把前綴買到的保護原封還回去：子網域寫得出裸名的
  cookie，只要伺服器肯讀，攻擊就照樣成立。代價是換上前綴的那一刻，既有的 session
  與訪客購物車全部作廢一次——使用者重新登入、訪客的車消失，都在可接受範圍。
- **後台 SPA 兩個名字都認。** `apps/admin/src/api.ts` 建置時不知道自己會跑在 http
  還是 https，因此依序試 `__Host-commerce_csrf` 與 `commerce_csrf`。這裡沒有安全代價：
  伺服器比對的是由 session token 推導出的值（ADR 0012），不是這張 cookie，
  讀錯一張只會讓請求被拒。

## 取捨

本機開發與正式部署的 cookie 名字不同，是這個決策最容易絆到人的地方——瀏覽器
DevTools 上看到的名字會隨環境變。替代方案是全環境一律用前綴、本機也上 https，
但那要求每個開發者處理憑證，成本高過它換到的一致性。

## Falsified if

`apps/api/src/http/cookie-names.ts` 的 `readCookie()` 開始回退到裸名，
或 `cookieName()` 不再由 `secureCookies()` 決定前綴，
或 `hostCookie()` 讓呼叫端蓋得掉 `path` / `secure` / `domain`，
或任何一處 cookie 的寫入 / 讀取繞過這些函式直接寫死名字
（`apps/api/src/http/session-cookies.ts`、`apps/api/src/http/cart-cookie.ts`、
`apps/api/src/http/session-start.ts`）—— 任一項成立，代表子網域覆寫這條攻擊路徑
又打開了，這篇記的理由要重新檢視。
