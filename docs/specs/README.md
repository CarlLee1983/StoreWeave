# 規格

**完整基底目標（2026-09-06）**：[Spec 0009](0009-complete-modular-base.md) 與
[Base 執行計畫](../base-implementation-plan.md)。B00 研究與 B01 模組契約均已完成驗證及獨立 Sol 審查，B02 已解鎖；未 commit／push／發布 GitHub，並保留以下既有規格。
狀態核對：Spec0008 Ticket81–90 已於2026-09-07完成本機驗收與Sol終審；Base B00–B01 已完成，B02–B17 尚未完成。

GitHub 派工入口：[Spec 0008 總單 #17](https://github.com/CarlLee1983/StoreWeave/issues/17)，內含完整規格與本批工單連結。

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
| [0007](0007-brand-content-and-contact.md) | 品牌內容與聯絡我們 | 0001–0006 | ready-for-agent |
| [0008](0008-admin-foundations-and-contracts.md) | 後台共用元件、資料狀態與 HTTP 契約收斂 | 既有後台 | done（本機驗收；未提交） |
| [0009](0009-complete-modular-base.md) | 完整應用基礎服務、模組契約與建站基底 | 既有 platform；Admin 部分銜接 0008 | in-progress；B00–B01 done，B02 已解鎖 |
| [0010](0010-auth-pages-as-declared-pages.md) | 認證頁面成為模組宣告的頁面 | 0009 的 B13；ADR 0047 | done（工單 92–98） |

0001 與 0002 沒有相依，可並行；兩條線在 0003 會合。加價購接在 0004 之後，
是定價引擎輸出「可加購清單」的延伸，不獨立成規格。

0006 接在既有購物核心之後；其 Ticket 57–67 先補可上線的付款與物流閉環，再處理售後、
電子發票與商品探索。它不重做已完成的 Cart、付款嘗試與 shipping domain model。

0008 來自 2026-09-06 的架構審視，對應 Ticket 81–90；Ticket 81 實作已存在，驗收待重新核對。

採 shadcn/ui 與 TanStack Query 漸進收斂後台；Ticket 91 另收納 ForgeFlowv2 discovery，
等待來源與使用場景，不阻擋本輪後台改善。各票指定 Terra／high 並列出相依、驗收與審查模型。

0010 收掉 B13 刻意留下的技術債：登入四頁仍是 decorator 路由。決策在 ADR 0047，
拆成工單 92–98；92 先把「簽發 session 只有一條路」修回來，那是 0047 轉 accepted 的前置。

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
