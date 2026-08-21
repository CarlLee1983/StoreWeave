# 0013. 行銷功能是 Commerce 模組，不是 Extension

- 狀態：accepted
- 日期：2026-08-22

## 背景

優惠券、購物金、加價購、滿額折這批行銷功能，直覺上該是 Extension ——
它們是「某些站台要、某些站台不要」的東西，而 ADR 0002 的建置時組裝正是為此存在。
`docs/extension-development.md` 的完整範例甚至就是 gift-wrap（加價購）。

但現行 Extension 機制做不到。三個硬限制：

1. **建不了資料表。** `ExtensionRegistration`（`packages/platform/extension-sdk/src/registration.ts`）
   沒有 `migrations` 欄位，`MigrationSet` 只掛在 `PlatformModule`。Extension 的持久化只有
   `platform_extension_state` 這個共用 KV 表，關聯查詢的正解是「請 Core 新增一個 Query」（ADR 0005）。
2. **攔不到既有 Command。** CommandBus 只有 `register`，同名重複註冊直接衝突，沒有 middleware
   或 before/after hook。Policy Registry 只能 `deny` 授權，`allow` 沒有效果，也改不了任何資料。
   所以 Extension 無法在 `commerce.order.placeOrder` 的交易內改價、加行或扣券。
3. **擴不了 Admin。** `apps/admin/src/router.ts` 的 `Route` 是寫死的字串聯集，
   `App.tsx` 的 `NAV_ITEMS` 是寫死的陣列。加一個頁面必須改 Admin 原始碼。

gift-wrap 範例示範的正是繞道走法：自己開一支 `ext.gift-wrap.requestWrap`、費用寫進自己的 KV、
事後訂閱事件補償。那不是加價購 —— 費用進不了訂單總額、進不了發票、進不了 `salesSummary`。

## 決策

**行銷功能是 `packages/commerce/promotion` 這個 Core 模組**，與 catalog、inventory、order 平起平坐。
它擁有自己的資料表，在 `placeOrder` 的同一個交易內被呼叫（限量券的扣減必須與訂單一起成敗），
並在 Admin 中有寫死的頁面。非購物型的產品靠 Bundle 不編進它，這正是 ADR 0002 與 0010 的用法。

**定價引擎的規則型別可插拔。** Core 提供 `PricingRule` 介面與內建規則型別，
未來若 Extension 取得建表能力，規則可以外移而不必重寫引擎。

**我們明確承認這是一筆技術債，而不是永遠不做。** 這個產品的定位是「可依專案擴充的基底」，
而目前 Extension 連自己文件裡的範例都做不出真貨。補上「Extension 可註冊 migration 與 Admin 頁面」
是一件獨立的平台工程，不混進行銷功能這一批 —— 混進去會讓 ADR 0005 的資料所有權規則同時被重寫，
兩件事互相遮蔽對方的風險。

## 考慮過的選項

- **順手擴充平台，把 promotion 做成第一個重量級 Extension。** 否決：工作量翻倍以上，
  且 ADR 0005 的三條所有權規則（Extension 拿不到 `tx`、資料以 `extension_id` 隔離、命名空間即契約）
  要同時重新設計。行銷需求不該是驅動平台改造的理由。
- **折扣規則放 Extension，只把「計算契約」留在 Core。** 否決：規則需要自己的資料表（活動、券、核銷紀錄），
  第 1 點就擋死了；就算把規則塞進 KV，第 2 點也讓它無法參與下單交易。

## 後果

- `packages/commerce` 從三個模組變四個。Bundle 的模組清單是決定「這個 Release 是不是購物站」的地方。
- Extension 的能力缺口變成一筆有記錄的債。任何人想在 Extension 裡做「會改變訂單金額」的功能，
  應該先讀這一篇，而不是重新發現一次 gift-wrap 的坑。
- promotion 與 order 之間走的是模組間 service 呼叫（ADR 0001），接受呼叫端的交易，不跨表。

## Falsified if

`packages/platform/extension-sdk/src/registration.ts` 的 `ExtensionRegistration` 出現 `migrations` 欄位，
或 `packages/platform/command-bus/src/command-bus.ts` 出現 middleware / interceptor 註冊點，
或 `apps/admin/src/router.ts` 的路由改成執行期可註冊 ——
任何一項成立，本篇的前提就消失，行銷功能是否該留在 Core 必須重新評估。
