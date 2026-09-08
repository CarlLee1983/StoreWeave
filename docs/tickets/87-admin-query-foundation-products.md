# 87 — 建立 Query 與身分快取邊界並遷移商品讀寫

**GitHub:** [#24](https://github.com/CarlLee1983/StoreWeave/issues/24)

**What to build:** 在 api.* 之上加入 TanStack Query，以商品清單／庫存／編輯形成第一條讀寫流程；同時完成所有頁後續共用的身分切換快取隔離。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §3

**Blocked by:** [Ticket 83 / #20](https://github.com/CarlLee1983/StoreWeave/issues/20)

**Status:** completed locally（2026-09-07；實作、完整驗證及 Sol/high 獨立審查通過，未 commit／push／寫入 GitHub）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

必要 Query provider／keys、main／App 的 cache lifecycle、ProductsPage 與 tests、api.ts 必要 signal／穩定 idempotencyKey 參數接線、依賴與 lockfile。其他頁 server-state 遷移分屬 88／89。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/main.tsx`
- `apps/admin/src/App.tsx`
- `apps/admin/src/api.ts`
- `apps/admin/src/api.test.ts`
- `apps/admin/src/pages/ProductsPage.tsx`
- `apps/admin/src/pages/CustomersPage.tsx`
- `apps/admin/src/pages/CustomersPage.test.tsx`

## Acceptance Criteria

- [x] QueryClient 是明確的單一 App lifetime；測試各自隔離。頁面仍只調 api.*，沒有第二個 fetch／resource provider。
- [x] 商品 query key 包含搜尋、狀態、limit、offset；庫存仍按本頁 IDs 批次查。快速變更條件時晚到回應不蓋過新結果。
- [x] 商品建立／編輯／狀態／庫存 mutation 成功使相關 query 失效並更新畫面；失敗保留輸入與可讀錯誤，不把網路錯誤轉成空資料或零庫存。
- [x] query 與 mutation 自動 retry 均明確 false；依 Spec §3 區分結果未知的同一操作與結果已確定後的新操作。前者含 timeout／斷線沿用原 key；後者由使用者明確發起才換 key，即使 payload 相同。invalidation 不重新執行 command。
- [x] 登入、登出、帳號／token 切換前取消舊查詢與清除 cache；晚到的舊 response 不能進入新 cache 或閃現；token／密碼不在 query key、持久化 cache 或新日誌裡。
- [x] Bearer／session、__Host- CSRF 優先序、envelope／ApiError 保留。測試涵蓋身分切換時 pending request、同 query 不重複載入、更新後讀取、CSRF、結果未知時 key 穩定，以及前次結果確定後新操作換鍵。
- [x] 移除商品頁舊 server-state effect／reloadKey，UI state 保留；實作時記錄 Query 版本與相容性，不導入 Redux／Zustand。

## Verification

pnpm typecheck；pnpm test；pnpm typecheck:admin；pnpm test:admin；pnpm build:admin。Sol/high 獨立審查 cache isolation、signal lifecycle 與 command idempotency；本機登入／token 切換與商品讀寫驗證。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Preparation（2026-09-07）

- Ticket 86 已完成本機驗收；本票先由 Sol/high 唯讀分析 cache lifecycle、signal 與 command 冪等邊界，再派 Terra/high 實作；準備階段尚未安裝 Query 或修改 runtime。
- 主代理保存 87 修改前快照於 `/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-ticket87-baseline-ha7_87gr`（Admin 與根層 dependency／TS／Vitest 設定），用來區分既有 81–86 dirty diff 與本票新差異；HEAD 仍為 `1f4470d`，不建立 commit 或 worktree。
- `npm view @tanstack/react-query version peerDependencies engines license --json`：候選 `5.102.8`、React `^18 || ^19`、MIT，未宣告 engines；安裝後仍須以本專案 Node 22／React 18／Vite／TypeScript 實測確認。
- [官方安裝說明](https://tanstack.com/query/latest/docs/framework/react/installation) 支援 React 18+；[官方 cancellation 說明](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation) 要將 query signal 傳入 fetch 才能取消底層請求。本票不採 Suspense Query 或另一套 fetch wrapper。

## Implementation plan（2026-09-07）

1. 已實作：Terra/high 建立 Query／API 接線、身分 lifecycle 與商品讀寫完整切片；沿用 Sol/high 分析 `/tmp/storeweave-ticket87-sol-high-analysis.md`。
2. 已通過當前版本的 focused regression、全 Admin／root unit/typecheck/build 與真瀏覽器身分／商品操作驗證。
3. 已完成：Sol/high 獨立審查及讀取錯誤狀態修正後的增量複核均完成，主代理核對最終 source hash 與驗收證據。

主代理決策：未確認商品操作以具體 App-lifetime memory-only store 保存不可變 payload/key，跨 route／locale remount 可重試；只保留 pending／unknown，身分切換先使舊 handle 失效並清除。保留正常關閉與導航，不增加全站 navigation guard。非空 API token 保存後清 currentUser；清 token 後以 api.me() 重新判斷 session。Query／mutation cache 在新身分畫面出現前清除，舊 command continuation 不得回填或 invalidate 新身分資料。

## Implementation evidence（2026-09-07；最終驗收）

- QueryClient、signal-aware product/inventory reads、identity cache boundary，以及商品四種 command 的 immutable pending/unknown recovery 已實作；recovered dialog 會保留原 draft/key，且焦點維持在 dialog 內。沒有成功的 product read 不會渲染空清單／零統計，read error 提供明確的手動 retry。
- Focused source regressions涵蓋同 key retry、definite rejection 後新 key、server-applied response-lost edit/set-stock replay、filtered-off-page recovery、同 key observer dedupe、filter late response、initial/new-filter read failure retry、inventory read retry 與 identity transition late-result guard。
- 已通過：`pnpm typecheck:admin`、`pnpm test:admin`（25 files／233 tests）、`pnpm build:admin`、`pnpm typecheck`、`pnpm test`（48 files／561 tests）、`git diff --check`。production build 僅有既有的 >500 kB chunk warning。
- 真 Chromium：主代理以最終 source 重跑完整 12/12 matrix 通過，涵蓋搜尋晚到、身分切換／session／CSRF、四種 command outcome/key、跨 route／locale recovery、已套用但回應遺失、焦點與 product/inventory read error。`/tmp/storeweave87-primary-browser.LveVUC/{check.mjs,results-all.json,full-run.log,source-before.json,source-after.json}` 及 screenshots；執行前後 41 個 runtime 檔案 hash 一致。以同目錄既有 Playwright／Chromium及隔離 Vite 重跑，`SCENARIO=<name> node check.mjs` 可指定單一情境。測試 Vite 已停止。
- Sol/high 首輪審查提出一項 Medium：商品讀取失敗仍顯示空／零結果，dismiss 標示卻執行 retry。已改為有實際成功資料才顯示結果區塊，ErrorBanner 提供三語明確 onRetry 並保留既有 onDismiss；新增 initial/new-filter failure regressions。增量終審 Code／Standards／Spec PASS，無剩餘發現；獨立 1 file／40 tests、Admin typecheck 通過，runtime/test hash 前後一致。兩個實作／審查 pane 已關閉。
- 主代理核對最終 runtime 與 browser hash 全數相符；保存 68 個 source/test/manifest hash 於 `/tmp/storeweave87-reviewed-source-final.json`。本票新增唯一套件 `@tanstack/react-query@5.102.8`（MIT、React 18/19 peer），Node 22／React 18 的實際 typecheck/test/build 通過；api signal/key/status 接線保持既有呼叫相容，無 DB migration 或 backend auth 變更。
- 全庫 integration／Docker smoke 的既有基準失敗仍由 Ticket 90 收尾，證據見 admin handoff；本票不宣稱整個 CI 已通過。

## Out of Scope

更換認證、改 backend retry／idempotency policy、預設自動重送、持久化 cache、其餘頁面遷移。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
