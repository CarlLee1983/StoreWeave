# 0045. 前台頁面由模組宣告，Theme 只提供渲染

- 狀態：proposed；B13 片1 開工前定案，實作與整合回歸通過後改 accepted。
- 日期：2026-09-10

`StorefrontTheme` 目前要求 13 個必需的 render 方法，其中 8 個是純商務頁——購物車、
結帳、取貨門市、訂單、帳戶訂單、購物金、優惠券、個人資料。約 20 個 `Theme*View` 型別
也都定義在 `packages/platform/kernel/src/theme.ts`。結果是平台層的公開契約直接編碼了
商務領域：一個形象網站的 theme 也必須實作 `renderCheckout` 才能通過型別檢查，而
base-only release 乾脆連 theme 都不載入（`availableThemes: {}`），前台整個是 404。
這和 ADR 0010「平台領域中立」相牴觸，只是先前沒有 base-only 的前台需求把它逼出來。

**方向反過來：模組宣告自己有哪些頁面，theme 對載入的模組提供 renderer。** kernel 只定義
頁面能力本身——頁面 id、path pattern、輸入解析、view 型別、audience 與所需權限，以及
`(ctx, view) => string` 的 renderer 簽名。`commerce/cart` 宣告 cart 與 checkout 頁，
`commerce/order` 宣告 order 與 account orders 頁；kernel 只保留跟任何領域無關的
home、error 與帳號頁。theme 是一份 page id 到 renderer 的對映，缺哪些頁由它宣稱支援
哪些模組決定。

四個不那麼明顯的決定：

**缺頁在啟動時就拒絕，不在請求時 404。** release 組裝完成後、開始服務之前，比對已載入
模組宣告的必需頁面與 theme 提供的 renderer，缺任何一個就拒絕啟動並列出缺哪些 page id。
相反的做法——執行期遇到沒有 renderer 的頁面才回 404——會讓一個換了 theme 的商店在
某位客人按下結帳的那一刻才發現結帳頁不存在。B13 的出口條件本來就要求「商務 Theme
缺必需頁面時被拒絕」，這裡只是指定它發生的時刻。

**路由從 decorator 移到註冊表，但契約檢查保留。** `apps/api/src/storefront/storefront.controller.ts`
現在用約 45 個 Nest decorator 列出所有 path，改成依註冊的頁面建立路由。既有的
`@HttpContract` 宣告式契約（`apps/api/src/storefront/storefront.contract.ts`）不因此消失，
它改成掛在頁面宣告上——資料驅動的路由如果同時放棄了 request 形狀、cookie effect 與
rate limit 的靜態檢查，等於用一個安全性退步換取彈性。

**theme 依賴 commerce 的型別，平台不依賴。** 商務 theme 會 import `@storeweave/cart` 的
page 型別來寫它的 renderer，這條邊存在且刻意——theme 本來就知道自己服務哪種網站。
被禁止的是反向：kernel 不得再出現任何商務 view 型別，因為那會讓所有 theme 都繼承
這個依賴。base-only release 的 theme 只 import kernel。

**視覺設定依 theme id 分開保存。** 現在 `theme.options` 是單一 record，換 theme 就換一套
schema，舊設定被覆寫。改成以 theme id 為鍵保存，換回去時原本的配色與標語還在。
代價是設定檔多一層巢狀，補償是「試用另一個 theme」不再是破壞性動作。

網站設定與導覽同時從 theme 抽出來，成為獨立於 theme 的資料——`packages/themes/default/src/layout.ts`
現在把導覽項目硬編碼成中文連結，換 theme 就換一套導覽，這在資訊架構上說不通。
這部分的儲存形狀與 migration 屬於 B13 片2，不在本決策範圍。

## Falsified if

`packages/platform/kernel/src/theme.ts` 重新出現任何商務 view 型別（cart、checkout、
order、rewards、coupons、pickup），或 `packages/platform/kernel/src/module.ts` 的頁面宣告
被移除而 theme 改回固定方法清單，或 `apps/api/src/storefront/storefront.controller.ts`
恢復以 decorator 逐條列出商務 path，或缺頁改成執行期 404 而非啟動時拒絕；
任一成立表示平台層又綁回了商務領域，或缺頁的代價又被推遲到客人身上，須重開本決策。
