# B13 — 網站殼與模組頁面

狀態：`done`（2026-09-10 結案）。五個切片實作完成，[PR #37](https://github.com/CarlLee1983/StoreWeave/pull/37) 的五個 CI job 全綠後合併進 main（merge commit `41a691c`）。結案證據是 CI 全綠加合併，**沒有** B04／B12 那種獨立審查——這包的證據比它們薄一層，是明知的取捨而非遺漏。

前置 [B03](../b03/README.md)、[B07](../b07/README.md)、
[B08](../b08/README.md) 與 Spec 0008 Ticket 90 全部結案；範圍依
[Base 執行計畫的 B13 派工卡](../../base-implementation-plan.md#b13--網站殼與模組頁面)
與 [Spec 0009](../../specs/0009-complete-modular-base.md) 的 F04／F05／F13。

本包關掉三個缺口：平台層的前台契約仍綁著商務領域、Admin 的頁面清單與後端載入了什麼
無關、B07 與 B08 的能力有 HTTP 沒有 UI。

## 開工時的現況

- `packages/platform/kernel/src/theme.ts:327` 的 `StorefrontTheme` 有 13 個必需 render 方法，
  其中 8 個是純商務頁；約 20 個 `Theme*View` 型別也在同一檔。base release 的
  `availableThemes` 是空的（`packages/platform/bundle/src/releases/base.ts:12`），
  base-only 前台一律 404（`tests/integration/base-release.test.ts:80`）。
- `apps/api/src/storefront/storefront.controller.ts` 以約 45 個 Nest decorator 寫死路由；
  「theme 有沒有這個版型」靠 optional method 是否存在判斷。
- 導覽硬編碼在 `packages/themes/default/src/layout.ts:69`；網站設定散在 config 的
  `store.*` 與單一 `theme.options`，DB 沒有對應資料表。
- `apps/admin/src/routes.tsx:50` 是編譯期靜態的 16 列陣列，側欄與命令面板直接掃它，
  沒有權限過濾；`GET /api/v1/auth/me` 只回 `role` 字串，不回 permission 清單。
  唯一「依能力決定 UI」的既有樣板是 `apps/admin/src/pages/ShippingPage.tsx:296`
  用 `api.listExtensions()` 判斷 ecpay 是否安裝。
- B07 的站內收件匣（`GET /api/v1/notifications`、`POST /api/v1/notifications/read`）
  沒有任何前端呼叫端。B08 的 change-password、verify-email、change-email、
  revoke-other-sessions 與五支 MFA 端點全部無 UI；operator 帳號管理
  （`listUsers`／`createUser`／`setUserStatus`）與 API token 管理連 HTTP controller
  都不存在，只能走 Bus 與 CLI。ADR 0044 指定的 MFA 強制註冊要在 UI 層做，但
  login 回應的 `mfaEnrolmentRequired` 目前沒有消費者。

## 決策

- [ADR 0045](../../adr/0045-modules-declare-storefront-pages.md)：前台頁面由模組宣告，
  Theme 只提供渲染；缺頁在啟動時拒絕；視覺設定依 theme id 分開保存。
- 帳號管理與 API token 的 HTTP controller 補在本包（使用者 2026-09-10 決定）。
  B08 交付時它們只有 Bus 與 CLI 入口，沒有這兩個 controller 就做不出帳號管理 UI，
  F04 也閉不了環。這讓 B13 含後端公開契約變更，不只是 UI。

## 切片

| 片 | 範圍 | 風險／owner |
| --- | --- | --- |
| 1 | Theme 契約反轉：kernel 頁面能力、模組頁面宣告、theme renderer 註冊表、啟動時缺頁檢查、default theme 遷移、storefront 資料驅動路由 | 高；主代理。**已完成** |
| 2 | 網站設定與導覽獨立於 theme：新資料表與 migration、theme options 依 id 保存、default theme 改讀導覽資料、base-only 前台 | 高；主代理。**已完成** |
| 3 | Admin 依有效模組與權限組裝 route／navigation：`/auth/me` 回 permission 清單、route 宣告所需權限與模組、側欄與命令面板過濾 | 高；主代理。**已完成** |
| 4 | users 與 api-tokens controller，以及對應的 Admin 帳號管理與 token 簽發頁 | 後端主代理；UI 可委派。**已完成** |
| 5 | B07 站內收件匣 UI、B08 帳號自助頁（改密碼／驗證信箱／換信箱／session／MFA）、login 的 MFA 挑戰與強制註冊 | 契約定後 UI 可委派。**已完成** |

片4 與片5 的 UI 檔案彼此不重疊，契約定案後可平行派兩個 implementer；共用接線檔
（`apps/admin/src/{App,routes,api}.tsx`、`kernel/theme.ts`、`apps/api/src/app.module.ts`、
`packages/themes/default/src/*`）維持單一 writer，留在主代理。

## 片1 的結果與遺留

29 個前台頁面由六個 commerce 模組宣告（catalog 3、cart 10、order 5、content 9、
customer 2、coupon 1、loyalty 1），`storefront.controller.ts` 從 1356 行減到 399。

`PageResolveContext` 比原先設計多了三個受限入口，理由見 ADR 0045：`cookies`、
`providers`、`clientKey`。

兩件事沒有在片1 收掉：

- **登入表單暫時列為 system page**（`platform.auth`）。它的寫入端點要簽發 session
  cookie，而頁面能碰的 cookie 只有訪客購物車那兩個動作。identity 的頁面遷移在片5
  一起做，屆時 `SYSTEM_PAGE_IDS` 應該只剩錯誤頁。
- **base-only release 仍然沒有前台**（片2 已收掉）。它當時沒有 theme、沒有宣告頁面的
  模組，`/` 是 404。

行為變更一項：Theme 缺少選配版型時，原本在請求時回 404，現在是啟動時拒絕
（ADR 0045）。`tests/unit/theme-assets-http.test.ts` 對應的測試已移除，替代覆蓋
在 `packages/platform/kernel/test/page-registry.test.ts`。

## 片2 的結果

`platform-site` 模組（`packages/platform/site`）擁有 `platform_site_settings` 與
`platform_site_navigation_items`，並提供 `platform.site.getChrome`／`updateSettings`／
`replaceNavigation`。導覽的預設值由 release 提供（`packages/platform/bundle/src/navigation.ts`），
不是 migration 塞進去的資料列——`ThemeContext` 因此多了 `navigation`、`tagline`、`footerNote`，
`packages/themes/default/src/layout.ts` 裡不再有任何寫死的連結。決策見
[ADR 0046](../../adr/0046-site-settings-and-navigation-are-release-data.md)。

`theme.options` 改成以 theme id 為鍵（ADR 0045 的未實作部分），bootstrap 只驗證並回寫
目前選用的那一組。舊的扁平寫法會在啟動時被 schema 擋下來，沒有相容路徑。

base release 因此有了前台：`packages/themes/base` 只實作 `platform.site.home`、
當時的 `platform.auth` 與 `platform.error`（認證那一項在工單 98 拆成八個具名頁面，見下），
`/` 回 200 而不是 404，匿名訪客用新的 `visitor` 角色。
`tests/integration/base-release.test.ts` 與 `scripts/smoke-base.sh` 已改成斷言這件事。

一項行為變更：頁尾的支援信箱從自己一欄移到品牌欄，`寫訊息給我們` 成為導覽資料的一項。

## 片3 到片5 的結果

`GET /api/v1/auth/me` 多回 `permissions` 與 `modules`；`apps/admin/src/routes.tsx` 的每一列
宣告 `permissions` 與選配的 `module`，`visibleRoutes()` 依它們過濾側欄與命令面板。
`account` 那一列的 `permissions` 是空陣列——自己的帳號是「登得進來就做得到」。
靜態 API token 進來的沒有身分可問，維持全部顯示；隱藏從來不是權限檢查，
`tests/integration/admin-accounts.test.ts` 用 readonly 直接打 `POST /api/v1/users` 釘住這件事。

新的後端入口：`apps/api/src/controllers/users.controller.ts` 與 `api-tokens.controller.ts`。
API token 從 runtime service 搬上 Command Bus（`platform.identity.issueApiToken`／
`revokeApiToken`／`listApiTokens`，權限 `tokens:read`／`tokens:write`），因此權限、稽核與
冪等與其他寫入命令同一套；秘密只在簽發那一次的回應裡出現。

新的 Admin 頁面在 `platform` 分組：操作者帳號、API Token、站內通知、我的帳號。
登入頁多了第二因素挑戰（後端回 `A multi-factor code is required` 時才出現輸入框），
`mfaEnrolmentRequired` 會把人帶到我的帳號並顯示提示（ADR 0044）。

## 認證頁的收尾（工單 92-98）

上面片1 留下的那一件事已經收掉。它確實是一次新的邊界決策，寫成
[ADR 0047](../../adr/0047-session-is-a-page-outcome.md)：session 變成 `resolve` 的回傳值
（`session-start`／`session-clear` 兩個 outcome kind），`PageResolveContext` 一個欄位都沒動，
所以 ADR 0045 的條件連重開都不必。

九頁（登入、註冊、忘記密碼、重設密碼各一組 GET／POST，加上登出）由新的 `platform-auth`
模組宣告，`storefront.controller.ts` 只剩 theme 靜態資產與物流商取貨回呼兩條路由。
四種認證版型拆成四個各自獨立的 view 型別，`SYSTEM_PAGE_IDS` 因此只剩錯誤頁——
做一個純展示 Theme 的人不必再為了通過啟動檢查寫一份登入表單。

## 出口

- 簡單非商務頁可掛前台與後台；一個 base-only release 能渲染出可瀏覽的網站。
- 帳號管理、登入復原、MFA 與站內通知都能從 UI 完成，沒有只存在 API 的交付缺口。
- 直接進 URL 仍須後端授權；隱藏選單不是權限檢查。
- 商務 theme 缺必需頁面時 release 拒絕啟動，不是執行期 404。
- 換 theme 保留內容、URL、導覽與網站設定，只有專屬視覺設定需要重新配置。

## 驗證

commerce-free 的 HTTP 與 Admin 流程、既有前台路由與 theme 回歸、鍵盤與視覺檢查、
完整 integration 與 Docker／native smoke。

片2 到片5 收工時的實跑結果（2026-09-10）：

| Gate | 結果 |
| --- | --- |
| `pnpm typecheck` | 乾淨 |
| `npx tsc -p apps/admin/tsconfig.json --noEmit` | 乾淨 |
| `pnpm test:unit` | 1064 通過 / 88 檔 |
| `vitest run --project admin` | 350 通過 / 32 檔 |
| `pnpm test:integration` | 838 通過 / 99 檔 |
| `pnpm smoke:native` | 65 通過 0 失敗 |
| `pnpm smoke:docker` | 66 通過 0 失敗 |

兩件收工時發現的事：Docker 映像的 `pnpm install --frozen-lockfile` 會因為
`pnpm-lock.yaml` 缺少新 workspace 的 importer 而失敗——新增套件時要一併補上
（本地的 `pnpm install` 不會自己補，因為那兩個套件沒有相依）。
另外片1 記錄的 `database-cutover` 環境競態這次沒有重現。

PR #37 的 CI（2026-09-10，run 34455625315）五個 job 全綠：typecheck + unit 3m20s、
integration shard 1/2 5m15s、shard 2/2 6m10s、smoke (docker compose) 1m37s、
smoke (native tarball) 1m18s。本機整跑與 CI 分片跑的結果一致，沒有只在 CI 出現的失敗。
