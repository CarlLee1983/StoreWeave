# 啟動時的組裝錯誤

組裝錯誤在建立資料庫之前丟出。模組圖的訊息以 `Module graph:` 開頭（`packages/platform/kernel/src/module-graph.ts`）；頁面來自 `page.ts`，job 來自 `job-registry.ts`。以訊息片段搜尋原始碼可找到判斷條件。

| 訊息片段 | 原因與修法 |
| --- | --- |
| `invalid module name` | `name` 須符合 `^[a-z][a-z0-9-]*$` |
| `requires Base <range>, running <ver>` | `baseVersionRange` 與平台版本不符 |
| `requires missing module` | required 相依沒組進這個 release：加進 `createModules` 或改為 optional |
| `requires <dep>@<range>, found <ver>` | 相依版本範圍不符 |
| `<kind> "…" is declared by both` | `data resource`、`permission`、`capability`、`migration owner` 撞名：改前綴或確認擁有者 |
| `repeats migration` | 同模組 migration id 重複：用下一個 id |
| `permission "…" has owner "…", expected` | 權限 `owner` 改成模組 `name` |
| `must bind capability … from installed module` | 宣告了能力需求但組裝時沒傳 `bindModuleCapability(...)` |
| `has undeclared binding` | 傳了 binding 卻沒在 `capabilities.required／optional` 宣告 |
| `頁面 id '…' 同時由模組` | page id 撞名 |
| `路由 <METHOD> '…' 同時由模組` | 同 method＋path 被兩個模組宣告（常見：兩個模組都想擁有 `/`，見 `createSiteModule` 的 `ownsHomePage`） |
| `Theme '…' 缺少 N 個必需頁面` | Theme 補 renderer，或該頁無畫面時設 `required: false` |
| `Job type "…" already registered` | job type 撞名 |
| `has no schema for current payload version` | `jobContractV1.versions` 補上 `currentVersion` 的 schema |
| `Job payload cutover blocked … without jobContractV1` | job 缺 `jobContractV1` |
| `HTTP adapter does not match the selected release` | `apps/api/src/releases/<id>.ts` 的 `releaseId` 與 release `id` 不同 |
