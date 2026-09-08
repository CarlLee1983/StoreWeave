# 82 — 建立 shadcn 基礎並替換共用選單與理由對話框

**GitHub:** [#19](https://github.com/CarlLee1983/StoreWeave/issues/19)

**What to build:** 在現有 Vite Admin 加入可直接使用的 shadcn primitives，將 RowMenu 與 ReasonDialog 的互動交給現成元件；第一張票就交付實際可操作功能。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §2

**Blocked by:** —

**Status:** complete (independent review PASS)

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-terra / high`

## Ownership

apps/admin/src/components/ui、RowMenu、ReasonDialog、必要 CSS／theme token／Vite／TS／components.json、實際依賴 manifest 與 pnpm-lock.yaml、apps/admin/DESIGN.md 及相關測試。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/vite.config.ts`
- `apps/admin/tsconfig.json`
- `apps/admin/src/main.tsx`
- `apps/admin/src/components/RowMenu.tsx`
- `apps/admin/src/components/ReasonDialog.tsx`
- `apps/admin/src/styles.css`
- `apps/admin/src/enhancements.css`
- `apps/admin/DESIGN.md`
- `package.json`
- `pnpm-workspace.yaml`

## Acceptance Criteria

- [x] 核對並記錄 React 18、Node、Vite、Tailwind 與 primitive 基底相容版本；只安裝已使用的元件依賴，現有工具鏈可建置。
- [x] RowMenu 保留 label、disabled、危險動作與 onSelect 語意；方向鍵／Enter／Esc 可操作，關閉回到 trigger。
- [x] ReasonDialog 保留必填 trim 後理由、取消不送出、危險樣式與原有 callers；焦點限制、可讀標題、Esc 和關閉後焦點返回由 primitive 負責。
- [x] 現有 routes 的未遷移 UI 不因 Tailwind reset／CSS layers 改壞；3 語、2 主題、360px／1280px 有瀏覽器驗證。
- [x] 測試可在 jsdom 運作且驗證使用者行為；移除兩個元件已被取代的 window listeners／舊樣式，只刪除無其他使用者的規則。
- [x] DESIGN.md 記錄新增元件位置與 token 對應，更新受本票取代的互動規範，不留下每個 dialog 必須手掛 useEscapeKey 的矛盾要求。

## Verification

pnpm typecheck；pnpm test；pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；共用元件與受影響頁面的瀏覽器鍵盤／主題檢查。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Implementation record (2026-09-06)

- Added shadcn source-distribution adaptations for Dialog and Dropdown Menu,
  backed by the two listed Radix packages. `src/components/ui/README.md`
  records the official source recipes and why this existing non-Tailwind app
  deliberately does not initialize the shadcn CLI or add a reset.
- Replaced `RowMenu`'s hand-maintained state/window listeners and
  `ReasonDialog`'s manual overlay/Escape handler. `BrandContentPage` still
  consumes the legacy `reason-dialog-*` styles, so those rules remain.
- Browser: an isolated local fixture exercised a real RMA RowMenu with
  ArrowDown/Enter, focused ReasonDialog textarea, and Escape returning to its
  trigger. Visual regression was checked in `繁體中文`, `English`, and `日本語`,
  both themes, at 360px and 1280px; no overflow, lost focus, or theme break
  was observed. The fixture used only synthetic data and no merchant service.
- Passed: `pnpm typecheck`; `pnpm test` (48 files, 561 tests);
  `pnpm typecheck:admin`; `pnpm test:admin` (21 files, 189 tests);
  `pnpm build:admin`; `git diff --check`.
- Independent review: `storeweave-82-review` (Terra/high, YOLO) PASS after
  read-only re-review. It confirmed the browser matrix record, source
  provenance, compatibility, behavior, legacy CSS consumers, and checks.
- Remaining risk: this is the first Radix pair in the Admin, so later component
  migrations should reuse these source slices rather than initialize a second
  UI system.

## Out of Scope

重新 scaffold 專案、React／Vite 全面升級、共享 UI package、自製 wrapper framework、全圖示替換、Query 或表單 state 遷移。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
