# 85 — 遷移訂單、會員、RMA 與出貨工作台 UI

**GitHub:** [#22](https://github.com/CarlLee1983/StoreWeave/issues/22)

**What to build:** 沿用共用元件整理四個操作型工作台，保持退款、調帳、退貨審核與物流的既有 guard 和送出行為。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §1、§2、§5

**Blocked by:** [Ticket 81 / #18](https://github.com/CarlLee1983/StoreWeave/issues/18), [Ticket 83 / #20](https://github.com/CarlLee1983/StoreWeave/issues/20)

**Status:** complete（2026-09-07；Sol/high 最終獨立複核 PASS）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

OrdersPage、CustomersPage、RmaPage、ShippingPage 及其 tests／i18n／專屬 CSS；只改呈現與互動接合。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/pages/OrdersPage.tsx`
- `apps/admin/src/pages/CustomersPage.tsx`
- `apps/admin/src/pages/RmaPage.tsx`
- `apps/admin/src/pages/ShippingPage.tsx`
- `apps/admin/src/pages/CustomersPage.test.tsx`
- `apps/admin/src/api.ts`
- `docs/tickets/46-manual-point-adjustment.md`
- `docs/tickets/68-admin-rma-workbench.md`

## Acceptance Criteria

- [x] 四頁已有 modal／drawer／reason／row menu 統一使用 primitives；內嵌明細保持可操作，無須把所有區塊強制改成 modal。
- [x] awaiting_payment 與 reward 顯示保持 81 的結果；原本可執行的取消／退款／調帳／RMA／出貨動作及條件不放寬。
- [x] 購物金與等級積分仍為不同操作，原因必填；同份表單沿用既有冪等鍵，連點或 Enter 不會新增第二個 command。
- [x] RMA 每行 restock／discard、discard 原因、客服生日修正理由與物流不透明標籤 handle 語意維持。
- [x] mutation 失敗時保留上下文／輸入，取消對話框不寫入；payload 與呼叫次數有 regression coverage。
- [x] 三語、雙主題、窄版及鍵盤流程有瀏覽器證據；刪除四頁已取代的互動程式與無引用 CSS。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin。重跑退款、會員調帳冪等、RMA 及 Shipping 元件測試；Sol/high 獨立檢查 action guards 與送出次數。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Implementation progress（2026-09-07）

- 已遷移 `OrdersPage`、`CustomersPage`、`RmaPage`、`ShippingPage` 的 modal／drawer／reason 與 row menu 接合；共用 `ReasonDialog`、`RowMenu`、Radix primitives、三語字串與對應頁面 regression tests 已一併更新。
- 退款、購物金與等級調整、RMA／出貨 mutation 都保留既有 guard；退款首次送出會快照原因與 idempotency key，timeout 後欄位鎖定，重送只會帶回相同 payload/key。失敗的 RMA reason 仍保留輸入與錯誤；Escape 會回到 row-menu trigger。
- 實測通過：`pnpm exec vitest run --project admin apps/admin/src/pages/OrdersPage.test.tsx --reporter=dot`（13 tests）、`pnpm typecheck:admin`、`pnpm test:admin`（21 files／200 tests）、`pnpm build:admin`、`pnpm test`（48 files／561 tests）、`git diff --check`。build 僅有既有的 >500 kB chunk warning。
- 隔離 fixture browser 已驗證：繁中 RMA 的 menu → reason dialog → Escape 回焦、英文 reason dialog、日文 Shipping，以及雙主題；本次再以 360px iframe viewport 實測 Shipping，table 維持水平捲動且工作台可操作。未使用商家資料。
- Sol/high 第一輪複核發現 timeout 後可能以舊 key 送出編輯後原因；已以快照／鎖定與 regression 修正。終審再發現會員調帳的相同風險與 ReasonDialog no-op error-dismiss：調帳已同樣快照並鎖定 amount/reason/key，ErrorBanner 現在接到實際 clear handler。全新 Sol/high 終審已 PASS；review pane 已關閉。

### Browser evidence

All browser checks used the isolated in-memory fixture at `http://127.0.0.1:4174/admin/`, never a merchant account or DB.

| Locale / theme / viewport | Exercised behaviour |
| --- | --- |
| `zh-TW`, 1280px | Returns row menu → Reject reason dialog → `Escape`; focus returned to the originating `更多操作` trigger and no command was sent. |
| `en-US`, 1280px | Returns reason dialog exposes translated Close, Cancel, and Reject controls. |
| `ja-JP`, dark and light, 1280px | Shipping workbench and provider/type labels render in Japanese in both themes. |
| `en-US`, dark, 360px | Shipping at a real 360px iframe viewport keeps the fixed table in its horizontal scroll container and retains Create/Edit/shipment controls. |

## Out of Scope

付款／退款狀態機、金額計算、權限、物流 provider、API 接口與 DB 變更；Query 遷移。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
