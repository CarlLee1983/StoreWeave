---
description: 理解 REST、Storefront、Admin 與背景入口如何共用應用能力，以及頁面渲染與後台操作復原的責任。
pageClass: architecture-page
---

# 介面與後台資料流

同一項產品能力可能由顧客表單、營運後台或外部整合呼叫。StoreWeave 把這些入口的差異留在介面層：HTTP 解析請求、Storefront 回傳 HTML、Admin 管理瀏覽器狀態；真正的命令與查詢仍交給應用中的 handler。

本章接著[模組與資料邊界](modules-and-data.md)，說明入口如何接上這些能力，再追蹤前台頁面與後台操作各自的生命週期。

## 六種入口，各自負責什麼

「共用 handler」表示產品規則不因呼叫入口而複製。它不表示每個入口都要先經過 REST，也不表示背景工作就是一次 HTTP 請求。REST、Storefront 與 MCP 把各自的輸入接上 Bus；CLI 與 Worker 則載入同一套 Runtime，執行各自的維運流程與背景工作。

| 介面 | 進入點 | 走的路 |
| --- | --- | --- |
| REST | `apps/api/src/controllers/*` | Command Bus / Query Bus |
| Storefront SSR | `apps/api/src/storefront/*` | Command Bus / Query Bus（storefront 角色） |
| Admin | 靜態 SPA → REST | 同上 |
| MCP | `apps/api/src/mcp/mcp.controller.ts` | Command Bus / Query Bus（以呼叫端的 actor） |
| CLI | `tools/cli/src/main.ts` | 同一個 `bootstrap()` 與 Runtime |
| Worker | `apps/worker/src/main.ts` | 同一個 `bootstrap()` 與 Runtime |

REST controller 把 HTTP 輸入轉成 Command 或 Query，並回傳 API 信封；例如共用的 `rest()` 依契約的 `target.kind` 選擇 Bus。Admin 是它的瀏覽器呼叫端。MCP 提供工具呼叫的入口，工具描述同樣指定 Command／Query target，沒有另一套業務 handler。

Storefront 在伺服器處理表單、查詢並渲染 HTML。表中的「storefront 角色」包含所選 Release 的匿名 Actor 與登入後的身分，不代表所有顧客共用一個固定 Actor。CLI 是直接載入應用的命令列工具；Worker 則處理 Outbox 與工作佇列，其投遞與重試見[事件與背景工作](events-and-jobs.md)。

來源：[REST 共用轉接](../../apps/api/src/controllers/base.ts)、[MCP 入口](../../apps/api/src/mcp/mcp.controller.ts)、[MCP 工具契約](../../packages/platform/extension-sdk/src/mcp.ts)、[CLI 入口](../../tools/cli/src/main.ts)、[Worker 入口](../../apps/worker/src/main.ts)。

## 介面的公開契約由目前的 Release 決定

一份部署只會組裝所選 Release 的能力。要確認「這個站點到底能呼叫什麼」，應查看執行中的契約目錄，而不是把倉庫內全部模組視為已啟用。

以下端點輸出目前 Release 的完整契約，包含 JSON Schema，可作為整合文件：

| 端點 | 內容 |
| --- | --- |
| `/api/v1/meta/commands` | 可執行的命令契約 |
| `/api/v1/meta/queries` | 可執行的查詢契約 |
| `/api/v1/meta/events` | 事件契約 |
| `/api/v1/meta/permissions` | 權限目錄 |

例如一個只選取 Base 模組的 Release，不會因為倉庫存在 Commerce 程式碼就自動具有訂單能力。Release 的選取與組裝方式見[平台、產品與 Release](platform-and-products.md)。

## Storefront：模組決定頁面，Theme 決定畫面

頁面是否存在、需要哪種身分、接受什麼輸入，以及要查詢或執行什麼操作，都由模組宣告。Theme 收到頁面整理好的 view，再產生 HTML。這讓換 Theme 成為呈現方式的變更，也讓平台不必預先認識購物車、訂單或住宿預訂的 view 型別。

每個 `StorefrontPage` 宣告 `id`、`path`、`method`、`audience`、輸入 schema、HTTP 契約與 `resolve()`。其中 `resolve()` 回傳 `PageOutcome`；路由層根據結果選擇渲染、轉址、開始／清除 Session 或回報找不到頁面。

一次顯示頁面的路徑是：

1. 路由層檢查頁面的身分需求，合併 path params 與 query／表單欄位。
2. 頁面的輸入 schema 解析資料，錯誤以輸入錯誤處理。
3. 路由層呼叫 `page.resolve(context, input)`；頁面透過受限的 Command／Query 入口取得結果。
4. 若結果是 `kind: 'view'`，以 `page.id` 找到 `theme.renderers[page.id]`。
5. Renderer 收到 Theme context 與 `outcome.view`，回傳 HTML；路由層設定 HTTP 狀態與內容類型。

例如商品頁可以把商品資料整理成 view，Theme 再決定圖片與價格的位置。新增商品規則屬於模組，改版型屬於 Theme。若某個 POST 頁面只執行操作後轉址，它可以沒有畫面，不必為它製造空 renderer。

組裝時會檢查頁面 id 與路由衝突，並確認 Theme 覆蓋全部必需頁面；缺 renderer 會拒絕啟動。`required: false` 才允許該頁面不提供 renderer。這避免網站啟動成功後，直到顧客按下結帳才發現 Theme 缺頁。

來源：[頁面與結果型別、組裝檢查](../../packages/platform/kernel/src/page.ts)、[路由執行流程](../../apps/api/src/storefront/storefront-routes.ts)、[ADR 0045：模組宣告頁面](../adr/0045-modules-declare-storefront-pages.md)。

## Session 是頁面結果，由路由層落實

登入不只是產生一張頁面：它還牽涉 Session cookie、訪客購物車合併與轉址順序。這些請求層的時序集中在路由層，頁面只回傳要發生的結果。

`PageOutcome` 有以下五種結果：

| `kind` | 路由層的處理 |
| --- | --- |
| `view` | 交給對應 Theme renderer，送出 HTML |
| `redirect` | 清洗目的地後送出 303 |
| `session-start` | 透過 Session effect 完成 cookie 等處理，再清洗目的地並送出 303 |
| `session-clear` | 清除目前請求的 Session，再清洗目的地並送出 303 |
| `not-found` | 轉為找不到頁面的錯誤 |

以登入為例，`platform-auth` 模組取得認證結果後，回傳帶有 `IssuedSession` 與目的地的 `session-start`。路由層再經 `ReleaseHttpAdapter.startSession` 處理 cookie 與適用的購物車合併；是否有購物車能力由目前組裝的模組決定。頁面不取得 request／reply，也不自行簽發 cookie。

這裡有兩個實際限制。第一，Session effect 失敗時不會送出成功轉址，但不保證登入被回滾：Session 可能已寫入資料庫，cookie 也可能已掛到回應。第二，匿名訪客需要登入時會被導向登入頁；已有真實身分卻不符合該頁 audience 時回 403，避免登入頁與會員頁互相轉址。

`PageResolveContext` 提供 Actor、locale、Command／Query 與具名的 cookie、provider、client key 入口，沒有整個 Runtime 或資料庫。認證能力由模組的 `bindPorts` 取得，與每次請求的 context 分開。這個限制讓頁面可以單獨測試，也避免模組依賴 HTTP 實作細節。

來源：[Session 決策與限制](../adr/0047-session-is-a-page-outcome.md)、[PageResolveContext](../../packages/platform/kernel/src/page.ts)、[結果分派](../../apps/api/src/storefront/storefront-routes.ts)、[Release HTTP adapter](../../apps/api/src/release-adapter.ts)。

## Admin：一個查詢快取，一個 HTTP transport

Admin 是 React 靜態 SPA。`main.tsx` 在 App 外建立共用的 `QueryClient` 與 operation store，頁面切換時繼續使用這些實例。它們的生命週期屬於整個 App，不屬於某一張表單。

資料讀取由頁面的 query 呼叫 `api.ts`，再由唯一的 `request()` transport 送往 REST。`query.ts` 集中管理 query keys：篩選、分頁與資源 id 是 key 的一部分，讓不同資料集合有自己的快取位置。

例如促銷列表的 key 由 `promotionKeys.list(input)` 建立。命令明確成功後，頁面 invalidate `promotionKeys.lists`，讓相關列表重新取得資料；編輯促銷也會 invalidate 相關成效查詢。因此「命令成功」與「畫面資料更新」是前後兩步，快取更新不是伺服器交易的一部分。

Transport 統一處理以下細節：

- 有 API token 時附上 Bearer header，並以 `credentials: 'same-origin'` 支援同源 cookie。
- 非 GET 請求讀取 CSRF cookie 並附上 `x-csrf-token`。
- 需要冪等保護時附上 `Idempotency-Key`；要復原的操作必須由呼叫端保留原 key。
- 解析 API 信封，將錯誤轉成帶 code 與 HTTP status 的 `ApiError`，並傳遞查詢取消用的 `AbortSignal`。

Query 與 mutation 都設定 `retry: false`。查詢失敗與命令結果未知需要不同處理，不能讓同一個自動重試策略代替使用者操作的語意。

來源：[App providers](../../apps/admin/src/main.tsx)、[QueryClient 與 query keys](../../apps/admin/src/query.ts)、[HTTP transport](../../apps/admin/src/api.ts)、[促銷命令與 invalidation](../../apps/admin/src/pages/PromotionsPage.tsx)。

## 未知命令結果如何復原

送出命令後連線中斷，只能說瀏覽器沒有收到確定結果，不能推論伺服器沒有完成操作。如果重新建立 request 或 idempotency key，就可能把一次操作變成兩次。因此 Admin 把這種操作記在獨立的 operation store，保留原 request 與 key。

`executeAdminOperation()` 先以 scope 登記操作，阻止同 scope 再開始另一筆。它依回應分成幾條路徑：

| 結果 | 保留什麼、接著做什麼 |
| --- | --- |
| 明確成功 | 移除操作記錄，執行查詢 invalidation 等確認後動作 |
| 明確拒絕 | 移除操作記錄，顯示拒絕原因 |
| 結果未知 | 保留為 `unknown`，等待以原操作重試 |
| 舊身分或舊 attempt 的回應 | 視為 `stale`，不套用確認後動作 |

明確拒絕目前是可辨識的 4xx `ApiError`，但排除 `IDEMPOTENCY_IN_PROGRESS` 與 `UNKNOWN_ERROR`。其他錯誤保守地留為未知。重試只能接回目前那筆 `unknown` entry，實際執行的是 `retryEntry.operation`，不是畫面剛改過的草稿。

例如促銷修改結果未知時，應重送原本那次修改；等它成功或明確拒絕，使用者才另開一個合法的新操作並取得新 key。若命令已成功、後續快取刷新失敗，也不能把它倒退成「命令未知」再送一次。

Query cache 與 operation recovery 都只放在記憶體，重新整理或關閉分頁會失去這些瀏覽器狀態。它們不是持久化的操作帳本；伺服器端的冪等紀錄另有自己的責任。

來源：[operation store 與結果分類](../../apps/admin/src/admin-operations.tsx)、[促銷操作呼叫端](../../apps/admin/src/pages/PromotionsPage.tsx)。

## 切換身分時，舊資料與舊回應一起失效

後台快取不能跨帳號沿用，舊帳號的未知操作也不能留給新帳號重試。登入、登出與 token 切換因此共用 `prepareIdentity()`，先結束舊身分的前端狀態，再建立新身分的畫面。

流程依序是：增加 identity epoch、進入 `checking`、清除目前使用者與開啟中的命令選單、清除 operation recovery、等待取消查詢，最後清空 query cache。operation store 清除時也增加 generation；未完成的舊命令即使稍後回來，也無法再更新新身分的操作狀態。身分查詢回應則以 epoch 判斷是否仍然有效。

帳號登入後，App 另外呼叫 `me()` 取得權限與已載入模組；登入回應本身不足以決定有哪些導覽頁。Admin 的 `routes.tsx` 從所選 Release 的 Admin projection 取得 routes、導覽、頁首 metadata 與 actions，再依權限與模組篩選可見項目。側欄可見性只改善呈現，每次 API 請求仍須在伺服器授權。

這個流程清除的是瀏覽器狀態，不會回滾已送出的伺服器命令。它解決的是舊資料、舊 recovery 與晚到回應污染新身分的問題。

來源：[身分切換與 epoch](../../apps/admin/src/App.tsx)、[generation 與 stale 判斷](../../apps/admin/src/admin-operations.tsx)、[Release routes 與可見性](../../apps/admin/src/routes.tsx)。

---

接著閱讀[程式碼地圖](code-map.md)，把各層責任對回實際目錄。

[上一章：模組與資料邊界](modules-and-data.md) · [下一章：程式碼地圖](code-map.md) · [返回架構導覽](../architecture.md)
