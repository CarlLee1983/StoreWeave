# 86 — 遷移後台外殼、登入與其餘營運頁 UI

**GitHub:** [#23](https://github.com/CarlLee1983/StoreWeave/issues/23)

**What to build:** 完成 App 外殼、命令面板、token panel 和其餘七個資料／作業頁的元件遷移，保持原有路由表、登入與 API 行為。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §1、§2、§5

**Blocked by:** [Ticket 83 / #20](https://github.com/CarlLee1983/StoreWeave/issues/20)

**Status:** completed locally（2026-09-07；實作、admin checks、真瀏覽器與 Terra/high 獨立終審通過；未 commit／push）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-terra / high`

## Ownership

App、LoginPage、AnalyticsPage、DlqPage、ErpPage、InvoicesPage、NotificationsPage、SystemPage、ContactInboxPage 及其 tests／i18n／CSS。App 的 auth state 邏輯不重構。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/App.tsx`
- `apps/admin/src/App.test.tsx`
- `apps/admin/src/routes.tsx`
- `apps/admin/src/router.ts`
- `apps/admin/src/pages/LoginPage.tsx`
- `apps/admin/src/pages/ErpPage.tsx`
- `apps/admin/src/pages/InvoicesPage.tsx`
- `apps/admin/src/pages/AnalyticsPage.tsx`

## Acceptance Criteria

- [x] Sidebar／topbar／login 和七頁使用既有 primitives；routes.tsx 仍是唯一導覽／標題／主要 action 來源，16 routes 與 hash URL 保留。
- [x] 命令面板使用現成 Command／Dialog 能力，保留 Cmd/Ctrl+K、搜尋、上下鍵、Enter、Esc；選取語意與焦點返回可由鍵盤／讀屏辨識。
- [x] token panel 的呈現可替換但登入、登出與 token 保存語意維持；不改認證協定、token 儲存位置或角色判斷。
- [x] ERP payload drawer、人工重送、DLQ retry、發票 issue／void retry 仍呼叫原 api.* 並保留允許條件，不把樣板的假資料／操作帶進來。
- [x] Analytics 日期篩選、金額格式、通知遮蔽資料、系統健康與聯絡收件匣處理行為維持。
- [x] 無資料、loading、error、長 payload、三語、雙主題與窄版可用；刪除本票已取代的 overlay／palette／shell 樣式。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；16 routes 導覽與登入／palette／ERP drawer 的瀏覽器 smoke。涉及 auth 行為改動即退回規格邊界並由 Sol/high 審查。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Implementation progress（2026-09-07）

- Sol/high 先做 read-only 邊界分析：不得改動 `commerce.admin.token`、Bearer/CSRF、靜態 token shortcut、角色判斷、登出 finally 或 token-version remount；分析 pane 已完成並關閉。
- 已將 App command palette 和 token panel 接到既有 Radix Dialog，保留 Cmd/Ctrl+K、Esc、搜尋、方向鍵、Enter；新增 option/listbox 語意及由 trigger 回焦。ERP payload drawer 也已遷移到 Dialog，移除 `useEscapeKey`／overlay consumer，Escape 回到原 Payload button。
- 已補 palette 的 combobox/listbox/active-descendant 關聯、option 非 Tab stop 與 native `scrollIntoView({ block: 'nearest' })`；Token 未儲存草稿關閉後重新開啟會由已存 token 重設，窄版隱藏文字後 trigger 仍有 `apiTokenSettings` accessible name。
- ERP 空清單使用既有 `EmptyState`、Actions 欄改由 i18n，並在八個欄頭加 `scope="col"`；Chromium aria snapshot 確認其映射為 `columnheader`。Analytics／DLQ／ERP／Invoices／Notifications／System／Contact inbox 的固定資料表以現有 `table-wrap` 局部橫捲：ERP 最小 980px、其餘觀測表 860px、Analytics 760px，未改動 81–85 的表格規則。
- 修後已通過 `pnpm typecheck:admin`、`pnpm test:admin`（23 files／210 tests）、`pnpm build:admin`、`git diff --check`。本機 Playwright/Chromium 隔離 fixture 已跑 16 routes、Login 與七頁的 zh-TW/en-US/ja-JP × dark/light × 360/1280 matrix；檢查標題、locale/theme、每頁無水平溢出、窄版固定表可局部橫捲、console/pageerror、`undefined`/`NaN`、palette keyboard/return focus、Token reset、ERP drawer 長 payload、empty/loading/error；共保存 39 張截圖於 `/private/tmp/storeweave-ticket86-playwright.lv9BsY/screenshots`。最終獨立終審與主代理目視驗收均已完成。
- Login 的 ≤420px 樣式已讓卡片與欄位可縮、demo pills 改單欄可換行、footer 可換行；12 格 Login matrix 逐一以 card、input、submit、demo pill、footer 及其文字 span 的 bounding rect 確認都在 viewport 內。最終 delta review 與主代理目視已通過；主代理比對 source hash 確認終審後無程式變動。

- 獨立審查：首輪三項 findings 已修；第二輪 Standards／Spec CodePASS；ERP `scope="col"` 與 Login 窄版 CSS 後續增量均由另一 Terra/high reviewer 複核 PASS。主代理另實測 Contact 操作按鈕局部捲動後完整可見。全部本輪 reviewer panes 與 implementation pane 完成後關閉，mock／Vite 已停止。
- 全庫附加驗證如實保留：root typecheck／unit 48 files、561 tests 通過；integration 504／505（promotion-crud 在未改動 HEAD 亦重現共享九月活動污染）；isolated Docker smoke 61／62（腳本事件數預期 7、實際 19）。細節見 [交接](../admin-implementation-handoff.md)，由 Ticket 90 closure 處理，不宣稱全庫綠燈。native smoke 本票未跑。
- Browser 重跑：在隔離工具目錄 `/private/tmp/storeweave-ticket86-playwright.lv9BsY` 前景執行 `node mock-api.mjs`，repo 前景執行 `pnpm exec vite --config apps/admin/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort`，再於工具目錄執行 `node browser-smoke.mjs`；兩個測試 server 需保持 session 存活。使用隔離 mock，不能指向商家資料。

## Out of Scope

自製 router 擴充、React Router、更換 auth provider、圖表系統、全量圖示換庫、Query 遷移。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
