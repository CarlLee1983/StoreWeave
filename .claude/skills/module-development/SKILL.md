---
name: module-development
description: 寫或擴充 StoreWeave 的 PlatformModule。用於新增模組，或在既有模組加資料表／migration、權限、Command／Query、事件訂閱、背景工作／排程、前台頁面、JSON API，以及把模組組進 Release。
---

# 模組開發

模組是一次 `defineModule({...})` 宣告（`packages/platform/kernel/src/module.ts`）。三方分工貫穿每一步：**模組宣告、release 授予、Theme 渲染**。模組只宣告自己擁有的資料、權限鍵與頁面；誰拿到權限、載入哪些模組由 release 決定；頁面長相由 Theme 決定。

完成的定義沿用 `AGENTS.md`：`make verify` 通過。

## 步驟

### 0. 確認落腳處

需要自己的資料表才寫模組。只接外部服務、資料由對方保管 → Extension，照 `docs/extension-development.md`；只改長相 → Theme。

**完成：** 能說出這個功能擁有哪幾張表。

### 1. 讀範本

動手前讀完 `packages/platform/site/src/` 全部檔案——它是最小的完整模組，檔案分工照抄：`module.ts`、`schema.ts`、`migrations.ts`、`descriptors.ts`、`pages.ts`、`index.ts`。需要事件訂閱、排程、`bindPorts` 時再讀 `packages/commerce/coupon/src/module.ts`。

**完成：** 每個要新增的東西都對應到範本裡的一個檔案。

### 2. 套件與接線

- 模組寫成工廠函式 `createXxxModule(options)`，`version` 讀 `package.json`，`baseVersionRange: '^1.0.0'`，`name` 符合 `^[a-z][a-z0-9-]*$`。
- `tsconfig.base.json` 的 `paths` 加 `@storeweave/<pkg>` 別名。新的產品目錄在 `pnpm-workspace.yaml` 補 glob。
- 相依寫進 `dependencies.required`，例如用通知就列 `platform-notifications`。

**完成：** `make typecheck` 解析得到新別名。

### 3. 資料

- `schema.ts`（Drizzle）與 `migrations.ts`（`sqlMigration(id, phase, sql)`）兩份都寫，表名一致。
- 表名加模組前綴，**每一張**都列進 `data.owns`。
- migration id 模組內單調遞增（`0001_init`、`0002_…`）。已發布的 migration 內容凍結，任何變更都寫成下一個 id。
- `phase`：`expand` 讓舊版程式照常運作；`migrate` 搬資料；`contract` 只在舊版不再需要回滾後發布。
- 預設資料由 release 組裝時以選項傳入，migration 只建結構（理由見 ADR 0046）。跨模組外鍵先讀 ADR 0021。

**完成：** 每張 `CREATE TABLE` 都出現在 `data.owns`，且 `runtime.migrate()` 第二次回傳 `[]`。

### 4. 權限

每個權限的 `owner` 等於模組 `name`。模組只宣告鍵；把鍵發給角色寫在 release 的角色目錄（`BASE_ROLES` 的形狀，見 `packages/platform/authorization/src/roles.ts`）。命名：`<領域>:read|write|manage`，匿名可讀用 `:public-read`。

**完成：** 每個 Command／Query 的 `permission` 都是本模組宣告的鍵，且至少一個角色擁有它。

### 5. Command 與 Query

- 寫入走 Command、讀取走 Query；Controller、頁面、Job 都只是呼叫端。
- `input` 是平的 `z.object({...}).strict()`（ADR 0024；HTTP 橋接要從它讀鍵）。
- 名稱 `<context>.<aggregate>.<action>` 是公開契約；形狀改變時提高 descriptor 的 `version`。
- 寫入的副作用用 `ctx.publish`、`ctx.enqueue`、`ctx.audit`，與資料在同一個交易。
- 「只看自己的」依 `ctx.actor` 在 handler 內限縮。
- 業務錯誤丟 `PlatformError`。有外部副作用或金額變動的 Command 用 `idempotency: 'required'`。

**完成：** 每個 descriptor 的 input 都帶 `.strict()`，每個寫入都能指出它的交易邊界。

### 6. 事件與訂閱

- 事件名稱 `<context>.<aggregate>.<action>.vN`，用 `defineEvent` 宣告並列進 `events`。
- 訂閱經 Outbox 非同步投遞，會重複送達：`ctx.executeCommand(name, input, dedupeKey)` 的第三個參數是去重鍵，由事件內容決定（`coupon-signup:${customerId}`）。
- 執行別的模組的 Command 要在訂閱者的 `commands` 列 `{ from, name, version }`，對方須是相依。
- 通知、認證、logger 從 `bindPorts(ports)` 取得。

**完成：** 每個訂閱者重送同一事件只產生一次效果。

### 7. 背景工作與排程

- 每個 job 都帶 `jobContractV1`（沒有它 payload cutover 會被擋）；改 payload 形狀時保留舊版 schema、提高 `currentVersion`。
- 排程：`{ everyMs }` → payload `{ bucket, scheduledFor }`；`{ cron, timezone }` → payload `{ scheduledFor }`，`timezone` 必填（IANA）。
- Job 沒有資料庫握柄，寫入走 `ctx.executeCommand`。外部副作用用 `ctx.idempotencyKey`，長工作聽 `ctx.signal`。
- 排程只 enqueue、由 Worker 執行；要在 Command 之後做的事用 `ctx.enqueue`。

**完成：** schema 的版本與 schedule 產生的 payload 形狀一致。

### 8. 前台頁面

- `definePage`，page id `<模組>.<領域>.<動作>`，`contract` 照 `packages/platform/kernel/src/http-contract.ts` 的 `StorefrontHttpContract`。
- `resolve` 回 `PageOutcome`：寫入成功回 `redirect`（PRG），驗證失敗回 `view` 加 `status: 400`；session 變動回 `session-start`／`session-clear`。
- `resolve` 只用 `PageResolveContext` 提供的入口；表單欄位用 `formValue`；節流鍵用 `ctx.clientKey`。
- 匯出 `export type XxxPages = typeof xxxPages`，讓 Theme 以 `defineTheme<... & XxxPages>` 對型別。
- Theme 對每個有畫面的 page id 提供 renderer（顯示與送出失敗共用一個），插值一律 `escapeHtml`。只做寫入與轉址的頁面設 `required: false`。範本：`packages/themes/base/src/index.ts`。

**完成：** 用這個 release 的 Theme 啟動不報「缺少必需頁面」。

### 9. JSON API

照 `apps/api/src/controllers/notifications.controller.ts`：`routes` 物件以 `kind: 'bus'` 指向 Command／Query，Controller 繼承 `BusController` 並呼叫 `this.rest(...)`。加進 `apps/api/src/releases/<release>.ts` 的 `controllers(...)`。

**完成：** 每條路由的 `target.name` 都是已註冊的 Command／Query。

### 10. 組進 Release

- `createModules` 是純同步函式，模組圖不隨設定內容改變；平台模組由 runtime 自動加入，這裡只列產品模組。
- 新 release id 要同時登記四處：`packages/platform/bundle/src/releases/<id>.ts`、`apps/api/src/releases/<id>.ts`（`releaseId` 相同）、`scripts/releases.mjs`、`scripts/build-release.sh` 的 `case`。
- 後台頁面在 `apps/admin/src/routes.tsx` 的 `ENTRIES` 加一列，帶 `module` 與 `permissions`。

**完成：** `bootstrapRelease(release, ...)` 啟動成功，`runtime.modules` 含新模組。

### 11. 測試

整合測試照 `tests/integration/base-release.test.ts` 用 `bootstrapRelease` 起真的 release。每個模組至少覆蓋：

- migration 重跑為空；
- 每個 Command 的有權限／無權限（含匿名角色）；
- 未知欄位回驗證錯誤而非 500；
- 事件寫入 Outbox、訂閱者重送冪等；
- 頁面 POST 成功 303、失敗 400 並重畫、輸出已跳脫；
- job 在 Worker 重啟後不重跑。

**完成：** `make verify` 綠燈（整合測試逐檔序列執行，放背景跑）。

## 現況邊界

以 main @ 86d87a8 為準；進度以 `docs/base-implementation-plan.md` 為準，這段隨之更新。

- 後台路由是 `apps/admin` 的編譯期清單，且只有 commerce release 打包後台（`scripts/releases.mjs` 的 `admin`）。非商務 release 需要後台時，先開邊界決策。
- 使用者媒體屬 B10（進行中）。模組的圖片欄位等 media 能力落地後再設計；ADR 0034 的 Theme image key 即將被取代。
- Cache／Storage 以 runtime 的 `cacheBindings`／`storageBindings` 綁到模組 id。
- 啟動時的組裝錯誤訊息與原因對照：[startup-errors.md](startup-errors.md)。
