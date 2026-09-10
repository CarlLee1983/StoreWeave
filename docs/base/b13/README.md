# B13 — 網站殼與模組頁面

狀態：`in_progress`（2026-09-10 開工）。前置 [B03](../b03/README.md)、[B07](../b07/README.md)、
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
| 1 | Theme 契約反轉：kernel 頁面能力、模組頁面宣告、theme renderer 註冊表、啟動時缺頁檢查、default theme 遷移、storefront 資料驅動路由 | 高；主代理。**進行中** |
| 2 | 網站設定與導覽獨立於 theme：新資料表與 migration、theme options 依 id 保存、default theme 改讀導覽資料 | 高；主代理 |
| 3 | Admin 依有效模組與權限組裝 route／navigation：`/auth/me` 回 permission 清單、route 宣告所需權限與模組、側欄與命令面板過濾 | 高；主代理 |
| 4 | users 與 api-tokens controller，以及對應的 Admin 帳號管理與 token 簽發頁 | 後端主代理；UI 可委派 |
| 5 | B07 站內收件匣 UI、B08 帳號自助頁（改密碼／驗證信箱／換信箱／session／MFA）、login 的 MFA 挑戰與強制註冊 | 契約定後 UI 可委派 |

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
- **base-only release 仍然沒有前台**。它沒有 theme、沒有宣告頁面的模組，`/` 依舊
  404。要讓一個沒有商務的網站跑起來，缺的是片2 的網站設定與導覽，以及一個只實作
  通用頁的 theme。

行為變更一項：Theme 缺少選配版型時，原本在請求時回 404，現在是啟動時拒絕
（ADR 0045）。`tests/unit/theme-assets-http.test.ts` 對應的測試已移除，替代覆蓋
在 `packages/platform/kernel/test/page-registry.test.ts`。

## 出口

- 簡單非商務頁可掛前台與後台；一個 base-only release 能渲染出可瀏覽的網站。
- 帳號管理、登入復原、MFA 與站內通知都能從 UI 完成，沒有只存在 API 的交付缺口。
- 直接進 URL 仍須後端授權；隱藏選單不是權限檢查。
- 商務 theme 缺必需頁面時 release 拒絕啟動，不是執行期 404。
- 換 theme 保留內容、URL、導覽與網站設定，只有專屬視覺設定需要重新配置。

## 驗證

commerce-free 的 HTTP 與 Admin 流程、既有前台路由與 theme 回歸、鍵盤與視覺檢查、
完整 integration 與 Docker／native smoke。逐片記錄命令、exit code 與 source identity。
