# 0015. 訂單金額模型：Adjustment 必定分攤到 line，金額欄位一次補齊

- 狀態：accepted
- 日期：2026-08-22

## 背景

`order_orders` 目前只有 `subtotal_cents` 與 `total_cents` 兩個金額欄位，而且
`placeOrder`（`packages/commerce/order/src/commands.ts`）讓 `totalCents` 恆等於 `subtotalCents`。
`order_lines` 有 `unit_price_cents` 與 `line_total_cents`，沒有折扣欄位。

一旦引入折扣，`totalCents` 的語意就從「等於小計」變成「計算結果」。這不是加一個欄位而已：
`commerce.order.placed.v1` / `.v2` 與 `commerce.order.paid.v1` 的 payload 都直接帶 `totalCents`，
demo-erp Extension 與 Admin 都在消費它，`salesSummary` 的 `grossRevenueCents` 與
`averageOrderValueCents` 也建立在它上面。依 ADR 0006，這是破壞性變更，要發新版本並讓舊版
活過至少一個 minor 週期。

## 決策

**折扣一律以 Adjustment 表達，且必定分攤到 line。** 一筆 Adjustment 有金額、來源與名稱；
訂單層級的折扣（滿額折、整單百分比、購物金折抵）按金額比例攤回各 line，餘數給最貴的那一行。

理由：退貨、開立發票與對帳都必須知道**每一件商品實際收了多少錢**。如果只在訂單層記一個折扣總額，
第一次部分退貨就會逼你重算歷史訂單 —— 那時資料已經沒有足夠資訊算得回來。分攤是不可逆的正確性前提，
不是效能或美觀問題。

**金額欄位一次補齊，不分兩次改。** `order_orders` 新增 `discount_cents`、`shipping_cents`、
`tax_cents`，`order_lines` 新增 line 層級的折扣欄位。運費與稅在這一批不實作，欄位恆為 0。

理由：事件版本升級有固定的儀式成本（發新版、舊版共存一個 minor 週期、下游逐一遷移），
做兩次要付兩次。而運費與稅在購物站上不是「會不會做」而是「什麼時候做」。留空欄位的代價近乎為零。

**購物金折抵是最後套用的 Adjustment，且只作用在商品小計上** —— 不折運費、不折稅。

## 考慮過的選項

- **只在訂單層記折扣總額，不攤回 line。** 否決：見上，這會讓部分退貨永久失去正確計算的依據。
- **只加 `discount_cents`，運費與稅之後再說。** 否決：等於預約第二次破壞性事件變更。
- **改用 numeric 型別以避免分攤餘數。** 否決：全庫金額一律是 integer minor unit，
  混用型別的成本遠高於「餘數給最貴那行」這條規則。

## 後果

- `commerce.order.placed` 與 `commerce.order.paid` 都要發新的版本號，舊版依 ADR 0006 續發一個 minor 週期。
  demo-erp 的 transform 與 Admin 的訂單頁是已知的下游。
- `salesSummary` 的營收語意改變：`grossRevenueCents` 之後是折扣後的實收金額。
  這支 query 與 `SalesSummarySection` 目前完全沒有測試覆蓋，遷移時要先補。
- 分攤演算法本身是純函式（定價引擎的一部分），可以在不連資料庫的情況下用大量 case 驗證餘數處理。

## Falsified if

`packages/commerce/order/src/schema.ts` 的 `order_lines` 不再帶 line 層級的折扣欄位，
或 `packages/commerce/promotion` 的分攤演算法允許訂單層 Adjustment 不攤回 line，
或 `packages/commerce/order/src/commands.ts` 的 `placeOrder` 重新讓 `totalCents` 恆等於 `subtotalCents`。
