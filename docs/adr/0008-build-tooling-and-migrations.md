# 0008. 以 esbuild 打包、SQL migration 內嵌於 TypeScript

- 狀態：accepted
- 日期：2026-08-21

## 背景

實作過程中出現幾個小型但會影響長期維護的決定，記在這裡避免之後被人「順手修好」而破壞原意。

## 決策

**1. 用 esbuild 打包，而不是 `tsc` + 執行期解析 workspace 套件。**
好處是路徑別名（`@storeweave/*`）在打包時就解析完，正式主機不需要 `node_modules`。
代價是 esbuild **不產生 `design:paramtypes`**，因此 NestJS 的建構子注入必須全部明確寫 `@Inject(...)`。
`apps/api/src/http/auth.ts` 有一行註解說明這件事。NestJS 若干選用相依（`class-transformer`、
`@nestjs/microservices` 等）在 `scripts/build.mjs` 標為 external，因為它們是 lazy require 且我們沒用到。

**2. SQL migration 內嵌在 TypeScript 檔案裡**（`packages/*/src/migrations.ts`）。
理由是打包後不需要額外複製 `.sql` 檔，也不需要在執行期解析 `__dirname`——
Docker 與 Native 的行為因此完全一致。每個 migration 帶 `phase` 標記（見 ADR 0007）。

**3. HTTP 狀態碼。** 真正建立資源的 `POST /api/v1/products` 與 `POST /api/v1/orders` 回 201，
其餘 POST（付款、取消、庫存調整、Extension command、MCP）回 200。所有回應都用統一信封。

**4. 預設 Theme 的 HTMX 是漸進增強。** `packages/themes/default` 產生的頁面在沒有 JavaScript 時
仍可完整瀏覽與下單；HTMX 由 CDN 載入，載入失敗不影響功能。不希望依賴外部 CDN 的部署
可以把 script 標籤拿掉，或改為自行 vendor。

**5. Theme 靜態資產隨 release 交付，且由 Theme 宣告公開 URL。** 有同源資產的 Theme 在
`StorefrontTheme.staticAssets` 宣告自己的 URL prefix；API 只掛載已宣告的 prefix，不特判
`default`。release 將資產放在 `theme-assets/<theme id>/`，啟動時若已宣告的目錄不存在便立即
失敗，避免把字型 404 留到顧客頁面才發現。本機從原始碼執行 API 時，開發指令明確設定
`COMMERCE_THEME_ASSETS_DIR`，不再用相對路徑探測 workspace。

Default Theme 的兩份 WOFF2 與各自的 OFL notice 是 release artifact 的一部分；
`scripts/theme-assets.mjs` 以來源雜湊驗證，build 與 Native release 都走同一份清單。
這和 HTMX 的漸進增強不同：字型是帶 session 頁面的必要同源資產，不能在執行期交給第三方
CDN；HTMX 載不到時則不影響標準表單交易。

**6. 付款在 Command 交易內同步完成。** `commerce.order.payOrder` 會在交易內呼叫 payment provider。
對 mock provider 是正確的；接真實金流時，建議改成「`requestPayment` 排入背景工作 →
工作呼叫 provider → `markPaid` Command」的非同步流程，`demo-erp` 已經示範了這個模式。
Provider Contract 已經要求以 `reference` 冪等，因此重試不會重複扣款。

## 後果

- 新增 Nest 的 provider 時**必須**寫 `@Inject`，否則會在執行期得到 `undefined` 依賴。
- 新增 migration 時直接改 TypeScript，不要新增 `.sql` 檔（不會被打包進去）。
- 有靜態資產的 Theme 必須宣告公開 prefix，release 必須交付相同 Theme id 的目錄；
  source 開發則必須明確設定 `COMMERCE_THEME_ASSETS_DIR`。

## Falsified if

`scripts/build.mjs` 改用支援 `emitDecoratorMetadata` 的編譯器（例如 SWC），
使得 `apps/api/src/http/auth.ts` 的明確 `@Inject` 不再必要；
或 Release 開始隨附 `node_modules`，使得路徑別名可以在執行期解析；
或 `scripts/theme-assets.mjs` 不再驗證 Theme 資產、`StorefrontTheme.staticAssets` 被移除，
或 API 又開始以特定 Theme id 決定靜態路由，代表這份 artifact 邊界需要重新檢視。
