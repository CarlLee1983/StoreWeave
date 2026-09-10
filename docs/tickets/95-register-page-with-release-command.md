# 95 — 註冊走模組宣告的頁面，註冊命令由 release 指定

**What to build:** 訪客在前台填完註冊表單就是登入狀態，購物站的註冊同時建立 Account 與 Customer，而且兩者仍然在同一筆交易裡——不會留下沒有 Customer 的孤兒帳號。認證模組不自己決定註冊要跑什麼，改由組裝它的 release 指定。

**Blocked by:** 94

**Status:** done

- [x] 註冊的 GET／POST 由模組宣告（`platform.auth.register`／`platform.auth.submitRegister`），controller 上對應的 decorator 刪除
- [x] 模組工廠接一個註冊命令參數（`registerCommand`）；購物站傳入 `commerce.customer.registerCustomer`
- [x] 註冊完成即登入（頁面交出 `session-start`），轉址清洗沿用 94 的路由層那一份
- [x] 帳號與 Customer 仍在同一筆交易裡建立——頁面只跑那一個命令，交易邊界仍在 handler 的 `ctx.tx`
- [x] 信箱已存在時回中性訊息，不成為帳號枚舉的管道（訊息裡不出現那個信箱）
- [x] 註冊的節流行為不變（契約仍宣告 `rateLimit: 'auth'`，路由與桶都沒換）

## 實作時一併改掉的小事

- `StorefrontController` 只剩 Theme 靜態資產與取貨回呼兩支，於是 `renderTheme`／`themeContext`／
  `html` 三個私有方法與它們帶進來的 import 一起刪掉。模組層的 module-scope 舊 helper
  （`catalogQuery` 那一批）是 B13 留下的，不在這一票的範圍。
- `SYSTEM_PAGE_IDS` 的註解跟著改：四頁都遷完了，留著 `platform.auth` 的理由從此只剩
  「聯集型別還沒拆」，那是工單 98。

## Review 之後改掉的事

- **登入與註冊表單補上 `_csrf`。** 遷移前 `POST /register` 掛 `@Anonymous()`，守衛從不驗
  CSRF；宣告頁面沒有 per-page 的強制匿名，所以只要請求帶著有效 session 就會驗。預設 Theme
  的認證表單沒有 `csrfField`，於是帶著後台 session 逛前台的營運者——導覽列對他顯示的正是
  「註冊／登入」——送出會拿到守衛的 JSON 403 而不是頁面。登入的同一個缺口是工單 94 留下的，
  同一行補掉。
- **`GET /register` 對已是會員的人轉址**，和登入頁同一個判斷：他沒有 `customer:register`，
  給他表單只會讓他填出一個註冊不成功的表單。
- **不再原樣轉述 `VALIDATION_ERROR`。** 註冊命令的輸入由 command bus 解析，它的驗證錯誤是
  `Invalid input for "commerce.customer.registerCustomer"`——對訪客沒有意義，卻把內部命令名
  印出去。改成頁面自己的一句話。
- **分不出類別的失敗往上拋，不編成 400 的註冊表單。** 遷移前的 catch 吞掉所有錯誤，資料庫
  故障期間註冊會是「400 加一句請稍後再試」，log 與監控都拿不到訊號。現在 CONFLICT／
  VALIDATION_ERROR／FORBIDDEN 各自映射，其餘交給錯誤頁。
- **`StorefrontController` 的考古層清掉。** 它現在只服務 Theme 靜態資產與取貨回呼兩支，
  留著 B13 之前的型錄／購物金／RMA helper 沒有意義。

## 留給工單 97 的前置

`registerCommand` 是一個沒人在啟動時驗證的字串：打錯字要等第一位訪客按下註冊才會變成
`Command not found`。同一套架構對 Theme 缺頁是啟動即拒絕（`assertThemeCoversPages`），
命令這一側沒有對應的檢查——模組目前只能替 subscriber 宣告 `ModuleCommandRequirement`，
頁面要呼叫的命令沒有地方宣告。那是 kernel 的邊界決策，不塞進這一票；工單 97 會傳入第二個
不同的命令，那時再一起做。

## 遷移帶來的兩個行為差異

- **註冊的身分從匿名訪客變成這個請求的身分。** 頁面拿到的是 `ctx.actor`，所以已經登入的
  顧客送出註冊表單會被 `customer:register` 擋下來（`customer` 角色沒有這個權限）。遷移前
  永遠是匿名訪客，於是會多開一個帳號並換掉 session。現在的結果是註冊頁附上中性的失敗訊息。
  因此 `registerFailure` 只原樣轉述 `VALIDATION_ERROR`，不再轉述所有 4xx——否則 FORBIDDEN
  的訊息會把權限鍵印給訪客看。
- **註冊的 CSRF 與登入同一套。** 宣告頁面沒有 per-page 的強制匿名旗標，所以帶著有效 session
  卻沒有 `_csrf` 的註冊會 403，而不是重新註冊。這與工單 94 對登入做的取捨相同。

## 邊界

形象站的組裝留到 97。這一票只讓購物站走通。
