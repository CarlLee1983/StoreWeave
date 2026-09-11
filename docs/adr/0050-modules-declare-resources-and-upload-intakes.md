# 0050. 模組宣告自己要的資源與上傳入口，後台頁走模組頁面

- 狀態：accepted（B16）
- 日期：2026-09-11

## 背景

B16 要一個「新接手者只新增模組與站點組裝、不改 base」的非商務模組範例。實際照做時碰到四個缺口：

- B09／B11 的 `RuntimeOptions.cacheBindings`／`storageBindings` 只是 `createRuntime` 的參數。`ReleaseDefinition`
  沒有欄位能傳它們，`bootstrapRelease` 也不傳，因此經 release 組裝的模組拿不到 Cache、Mutex 或 Storage。
- 前台頁面只收 `form`／`query`。全域 multipart parser 設定 `fields: 0, parts: 1`，而且 CSRF guard
  從 body 讀 `_csrf`，所以頁面收不了檔案；可以收檔案的只有 `apps/api` 裡手寫的 controller。
- 後台 SPA 的路由表在 `apps/admin` 編譯期固定，而且只有 commerce release 打包後台。
- 模組沒有對應 `runExtensionContractChecks` 的契約檢查工具。

## 決策

1. **資源由模組宣告，runtime 綁定。** `PlatformModule.resources` 列出 `cache`、`storage`（Mutex 隨 cache 一起給），
   `bindResources` 在 handler 執行前被呼叫一次，拿到的 scope 固定在模組 id 推導的 namespace。這延伸 ADR 0040
   的 `bindPorts`：邊寫在宣告裡、組裝期注入、沒有執行期查詢。宣告與 hook 必須成對，否則模組圖驗證就拒絕。
   `RuntimeOptions` 的兩個 binding 參數保留給沒有模組宣告的平台節點與測試。
2. **上傳是模組宣告的 intake，不是頁面。** `PlatformModule.uploads` 宣告名稱、允許的 content type 與收件
   Command。通用的 `POST /api/v1/modules/:module/uploads/:upload` 以**收件 Command 自己的權限**把關，並在讀 body
   前預先驗證 Command 的 input；intake 不另設權限，免得「寫得進位元組」與「執行得了 Command」分岔。位元組串流進
   該模組的私有 storage scope（owner 是呼叫者），再以同一個 actor 執行收件 Command，輸入是
   `{ storageObjectId, ...query string }`；Command 失敗就刪掉剛寫入的物件。收件 Command 不可要求冪等鍵，端點也不轉送：
   每次都是新的位元組。端點走 `upload` 節流桶，由 base 與 commerce 的 HTTP adapter 一律掛上（沒有 intake 時回 404），
   宣告了 intake 的模組因此在任何 release 裡都收得到檔案。位元組不進 Command Bus，multipart 與 CSRF 的全域設定不變：
   瀏覽器頁面以 `X-CSRF-Token` header 送出，與 media 上傳相同。上傳入口對會員開放時，配額是模組的責任
   （範例限制每人未結案的申請數）。
3. **非商務模組的後台畫面是 `audience: 'operator'` 的模組頁面。** 權限在 Query／Command handler 檢查，
   頁面只是呼叫端；不為範例打開 Admin SPA 的編譯期路由表。
4. **模組契約檢查以 release 為範圍。** `runModuleContractChecks(release, moduleName)` 放在 `@storeweave/bundle`：
   相依是否存在、版本是否相符、權限是否發給角色，都是 release 的事實，單看一個模組回答不了。

## 後果

- 新模組需要 Cache／Storage／上傳時，只改模組與 release 檔；base 不必再為個別模組加 binding 或 controller。
- 上傳入口一律私有、一律先授權；公開下載、簽章 URL 或媒體處理仍分別走 B09 storage 與 B10 media 的 policy。
- 模組頁面做後台只適合自成一格的小模組；需要 Admin SPA 的模組，另開 Admin 動態路由的決策。

## Falsified if

`packages/platform/kernel/src/module.ts` 的 `bindResources` 能在 handler 執行期間重新取得或換掉 scope、
`packages/platform/kernel/src/runtime.ts` 綁給模組的 namespace 不再由模組 id 推導，或
`apps/api/src/controllers/module-uploads.controller.ts` 在以收件 Command 的權限授權前讀取 body、或 Command 失敗後保留物件，
則重開本決策。若 `apps/admin/src/routes.tsx` 改成依模組宣告動態產生路由，第 3 點不再成立。
