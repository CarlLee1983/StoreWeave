# 81 — 收斂後台 Order HTTP 型別與待付款顯示

**GitHub:** [#18](https://github.com/CarlLee1983/StoreWeave/issues/18)

**What to build:** 後端已有 awaiting_payment 與 reward adjustment，Admin 型別和畫面仍漏列。從權威契約推導瀏覽器可用的 Order 投影，補上顯示與篩選；維持 HTTP JSON 與商務規則。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §4

**Blocked by:** —

**Status:** locally-verified（`1f4470d fix(admin): align order HTTP contract`，本輪補齊契約投影／型別接線與 regression coverage；未 commit／push）。

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

`packages/commerce/order` 擁有的 browser-safe type-only export／subpath、apps/admin/src/api.ts 的 Order 相關型別、OrdersPage、StatusBadge、i18n 與對應測試；必要的 workspace／TS 型別接線。純契約拆檔仍歸 order，不將 Order 搬進領域中立的 platform/contracts，也不從 runtime-heavy Order barrel import。不要重整其他 commerce 模組。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## 本地驗收紀錄（2026-09-06）

- 實際改動：`http.ts` 由 Order DTO 的 type-only 明確投影推導；repository 不再手寫 adjustment source union；Admin 獨立 tsconfig 只解析 shipping DTO；OrdersPage fixture 驗證三語與 JSON 日期顯示。
- 通過：`pnpm typecheck`、`pnpm typecheck:admin`、`pnpm test:admin`（19 files／184 tests）、`pnpm build:admin`；production bundle 未含 Nest／Drizzle／pg／Node runtime。
- 瀏覽器：隔離 fixture（無商家資料）確認中文 status/filter/pending count、英文／日文 status＋日期，以及明細 trigger 的 Enter 開關後焦點保留。
- 獨立 Sol/high review：原始提交發現 HTTP projection／source drift 與測試缺口；修正後程式、bundle 與瀏覽器證據複核通過。
- 未通過但非本票：`pnpm test` 固定於 `tests/unit/cli-json-output.test.ts:33` 失敗（560/561）；本票未碰該 CLI 路徑，後續獨立處理。

## Read first

- `packages/commerce/order/src/dto.ts`
- `packages/commerce/order/src/queries.ts`
- `apps/admin/src/api.ts`
- `apps/admin/src/pages/OrdersPage.tsx`
- `apps/admin/src/components/StatusBadge.tsx`
- `apps/admin/tsconfig.json`
- `tests/architecture/boundaries.test.ts`

## Acceptance Criteria

- [ ] Admin 的 status、adjustment source 由同一權威來源推導；保留明確欄位投影，不再手抄 union。
- [ ] HTTP 日期在 Admin 是字串；nullable、reward adjustment 與既有 staff 投影可安全使用；現有 API JSON shape 不變。
- [ ] awaiting_payment 可用三語顯示、篩選並計入待付款分類；action 只呈現既有 command 允許的能力，不新增付款／取消／退款規則。
- [ ] 一個具代表性的 regression fixture 同時含 awaiting_payment、reward adjustment 與 JSON 日期；驗證清單、篩選及顯示，不以 as assertion 隱藏差異。
- [ ] Admin 獨立 tsconfig、Vitest 與 Vite 能解析型別；production bundle 沒有新增 Nest／Drizzle／pg／Node runtime。

## Verification

pnpm typecheck；pnpm test；pnpm typecheck:admin；pnpm test:admin；pnpm build:admin。保持既有 HTTP／訂單整合測試於 CI 通過；此票不需要 DB migration。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Out of Scope

完整 OpenAPI／SDK generator、所有 domain DTO 的全面搬家、回應新增欄位、權限或狀態機變更。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
