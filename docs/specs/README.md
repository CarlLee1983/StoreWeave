# 規格

由 2026-08-22 的 grilling 產出，共 36 個決策點。詞彙定義見根目錄 `CONTEXT.md`，
架構決策見 `docs/adr/`（本批相關者為 0013、0014、0015，並補充了 0009）。

| # | 規格 | 依賴 | 狀態 |
| --- | --- | --- | --- |
| [0001](0001-customer-identity-and-membership.md) | 顧客身分與前台會員 | — | ready-for-agent |
| [0002](0002-pricing-engine-and-order-money-model.md) | 定價引擎與訂單金額模型 | — | ready-for-agent |
| [0003](0003-cart.md) | 購物車 | 0001, 0002 | ready-for-agent |
| [0004](0004-coupons-and-marketing-codes.md) | 優惠券與行銷碼 | 0001–0003 | ready-for-agent |
| [0005](0005-points-tiers-and-analytics.md) | 購物金、會員等級與行銷分析 | 0001–0004 | ready-for-agent |
| [0006](0006-commerce-operations-closure.md) | 購物營運閉環：付款、履約、售後與探索 | 0001–0005 | ready-for-agent |

0001 與 0002 沒有相依，可並行；兩條線在 0003 會合。加價購接在 0004 之後，
是定價引擎輸出「可加購清單」的延伸，不獨立成規格。

0006 接在既有購物核心之後；其 Ticket 57–67 先補可上線的付款與物流閉環，再處理售後、
電子發票與商品探索。它不重做已完成的 Cart、付款嘗試與 shipping domain model。

## 測試接縫

四個，跨全部規格共用：

1. **純函式（unit）** — 定價引擎、分攤、帳本推導。這是新接縫，也是本專案第一個領域邏輯的
   套件級單元測試套件；組合爆炸只有在這裡測得動。
2. **Command / Query Bus（integration）** — 系統最高的接縫，所有介面都經過它。
   前例：`tests/integration/flow-order-outbox.test.ts`。
3. **HTTP（integration）** — 只用於守衛層看得到而 Bus 看不到的行為（session、CSRF、`@Public()`）。
   前例：`tests/integration/auth-http.test.ts`。
4. **Admin 元件（jsdom）** — 既有 project，不新增接縫。前例：`apps/admin/src/pages/DlqPage.test.tsx`。

## 已知的既有問題

不在任何規格的範圍內，但已記錄：

- `storefront` 角色持有無範圍限制的 `order:read`，以訂單號查詢不驗身分 —— 任何人猜到訂單號
  就能讀別人的訂單。修復在 Spec 0001（依賴 `Actor.type` 擴充，無法更早單獨處理）。
- `POST /checkout` 的 idempotency key 每次現產，等於沒有冪等保護。修復在 Spec 0003
  （正確的 key 來源是購物車 id）。
