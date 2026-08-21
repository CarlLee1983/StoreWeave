# StoreWeave domain glossary

## Order

A customer's immutable-priced purchase request. An Order is `pending` until a payment request is made, `payment_processing` while the provider is being contacted, `paid` after payment is confirmed, `cancelled` after an explicit cancellation, or `expired` when its payment reservation reaches its deadline.

## Inventory reservation

A temporary claim on sellable stock made for every Order line. It increases `reserved` without reducing `on_hand`; it is committed on payment, or released on cancellation or expiry. `available` is `on_hand - reserved`.

## Payment request

The durable request to charge a provider for an Order. It is not a successful payment; the only successful payment transition is `markPaid` after provider confirmation.

## Customer

一個會下單的人。Customer 擁有生日、會員等級、等級積分與購物金餘額。Customer 與後台操作者共用同一套帳號與 session 機制，但兩者的資料分屬不同模組：帳號只知道「這是一個帳號」，不知道他是顧客還是店員。結帳必須是已登入的 Customer。

## Cart

一份可變的、尚未定價凍結的購買意圖。Cart 可以屬於一個匿名訪客，也可以屬於一個 Customer；訪客登入後，其 Cart 併入該 Customer 的 Cart。Cart **不預留庫存**——放進 Cart 不保證買得到。Cart 轉成 Order 的那一刻，價格才凍結。

## Adjustment

一筆對價格的具名調整：有金額、有來源、有名稱。Order 與 order line 上的折扣一律以 Adjustment 表達，且**必定分攤到 line**——退貨、開發票與對帳都需要知道每一件商品實際收了多少錢。Order 的總額是商品小計加上所有 Adjustment 的結果，不再等於小計。

## Promotion

一條定價規則：在什麼條件下、對什麼範圍、折多少。Promotion 有優先序與「可否與其他 Promotion 疊加」的旗標。滿額折這類人人適用的活動只需要 Promotion，不需要 Coupon。

## Coupon

一張具名的券，指向某個 Promotion。Coupon 有自己的狀態（已發放、已使用、已過期）。它可以是**實發**的——發到某個 Customer 身上、只有他能用（生日禮券、新會員禮券）；也可以是一組**共用碼**——沒有擁有者，任何知道碼的人都能用（公開折扣碼）。Coupon 的核銷紀錄同時是行銷分析的事實來源。

Coupon 也可以指向一個合作夥伴，成為**行銷碼**——與名人或通路合作發出的共用碼，除了折價之外還把該筆訂單歸因於他。歸因只認結帳時實際輸入的碼，不認連結點擊；一張 Order 最多只能有一個帶歸因的 Coupon。佣金不由系統計算。

## 等級積分（tier points）

累積用來決定會員等級的數值。等級積分不能折抵金額。等級積分以滾動十二個月計算，因此會降級；它與購物金一樣以 ledger 記錄每一筆的時間，等級是 ledger 的推導值。

## 購物金（reward points）

可折抵訂單金額的準貨幣，以分批 ledger 記錄，每一批有自己的有效期；餘額是 ledger 的推導值，不是一個欄位。購物金的累積條件與等級積分不同。折抵永遠是最後套用的 Adjustment，且只作用在商品小計上。訂單取消時，折抵過的購物金與已累積的購物金都以反向分錄回沖，用掉的 Coupon 恢復可用；部分退貨不在目前的模型內。

在任何文件、程式碼與介面中都不單獨使用「點數」二字——它一律是「等級積分」或「購物金」其中之一。

## 會員等級

由等級積分決定的顧客分級。等級不是獨立的折扣系統，它只是定價引擎的一個輸入變數：影響適用哪些 Promotion，以及購物金的累積倍率。
