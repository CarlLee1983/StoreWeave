# Spec 0008 — 後台共用元件、資料狀態與 HTTP 契約收斂

- GitHub：[Spec 0008 / #17](https://github.com/CarlLee1983/StoreWeave/issues/17)
- 狀態：done（2026-09-07，本機 Ticket81–90 全部完成驗收；Sol/high 終審 PASS，未 commit／push）。
- 依賴：既有 Spec 0001–0007 已落地的後台與 API
- 基準：2026-09-06，commit `ee45e45`
- 執行：依工單順序交給 `gpt-5.6-terra / high`；本規格不代表已完成實作。
- 相關決策：ADR 0007（同一份 release）、0010（平台領域中立）、0012／0023（身分與 cookie）、0024（輸入契約）、0032（商品狀態）、0033／0034（品牌內容）。
- ForgeFlowv2：未來整合另由 Ticket 91 查證，不阻擋本規格的後台改善。

## Problem Statement

後台已有完整商務入口，但各頁重複實作選單、抽屜、表單外觀、資料載入與重新查詢。
手刻互動也持續承擔焦點管理、鍵盤操作與無障礙成本。這一輪採用現成元件與資料狀態工具，
讓後續開發集中在商品、訂單、庫存、退款等具體行為。

前後端另有已證實的契約漂移：Admin Order 漏列 `awaiting_payment`，
OrderAdjustment 只接受 `promotion`，而後端也會回傳 `reward`。
這是本輪需修正的行為缺口，不能期待換 UI 自動解決。

## Current Baseline

- `apps/admin`：React 18、Vite 6，16 個 routes；`routes.tsx` 是導覽與頁首的唯一來源。
- `api.ts` 集中 fetch、Bearer／cookie session、CSRF、Idempotency-Key、回應 envelope 與 ApiError。
- `styles.css` 與 `enhancements.css` 依序載入，盤點共 2,832 行；14 處 payload-overlay、17 處 dialog 標記。
- 已使用 `react-day-picker`；DateTimeField 組合日期與原生 time，保留現有本地日期語意。
- 2026-09-06 實跑 `pnpm typecheck:admin` 與 `pnpm test:admin` 通過：19 檔、180 測試。
  此基準不代表瀏覽器視覺、完整無障礙或後端整合測試已驗證。
- 後端為 NestJS／Fastify → Command／Query → Commerce，外部整合經既有 Extension／Outbox／Jobs。

## User Stories

1. 營運人員可以用鍵盤完成選單、抽屜與確認操作；關閉後回到合理的焦點位置。
2. 切換搜尋、狀態與分頁時，顯示的是對應查詢的結果；儲存後相關畫面更新。
3. 登出、換帳號或換 API token 後，不會看到前一個身分的快取資料。
4. 開發者可沿用一套元件與查詢方式，不必為每一頁再造互動或資料載入框架。
5. 新的訂單狀態與折抵來源在 Admin 與 HTTP 契約中保持一致。

## Scope and Decisions

### 1. 保留的架構邊界

Admin 維持 React／Vite SPA、`/admin/` 靜態交付、既有 hash URL 及 routes 單一來源。
商務頁透過 `api.*` 呼叫後端；授權、稽核、交易、狀態機與外部副作用仍由原有後端處理。
這一輪不修改 REST 路徑、輸入、回應 envelope、權限或資料庫 schema。

### 2. UI 元件

採 shadcn/ui，元件放 `apps/admin/src/components/ui`，先服務 Admin 這一個消費者。
沿用現有 DESIGN.md 的資訊密度、雙主題、字體與三語；選定同一組 primitive 基底，
只安裝已使用的元件及必要依賴。實作時核對 React 18、Node、Vite 與 Tailwind 的相容版本，
記錄選用版本；不用新專案 scaffold 覆寫現有設定。

先完成 RowMenu／ReasonDialog 的既有語意與呼叫端相容，再用商品頁驗證 Sheet、
欄位、按鈕與 Table；之後逐組遷移。可保留帶有商務語意的薄組合元件，
例如 ReasonDialog 的必填理由，避免每頁重複；不用自製通用 UI 引擎包住全部 shadcn API。

Tailwind 的 reset、CSS layer 與 theme token 必須以現有頁面回歸驗證。
每個元件遷移同時刪除已無使用者的舊互動程式與樣式；仍被下一批頁面使用的規則保留到該票完成。
只移除證實無引用的 CSS，不以行數下降當作成功指標。

### 3. Server state

採 TanStack Query，位於頁面與 `api.ts` 之間。它管理資料快取、loading／error、
查詢失效與重新查詢；表單草稿、抽屜開關、選取等 UI state 留在 React。

同一實際查詢只有一套 query-key 定義，key 包含全部影響結果的輸入。
mutation 成功只使受影響資料失效；跨頁共用的訂單、會員、庫存、發票與作業佇列必須一起考慮。
不創造通用 resource provider 或第二套 fetch wrapper。

這一輪 query 與 mutation 的自動重試均明確關閉，保留可觀察的人工重試。
一次操作開始前建立冪等鍵；連點或 timeout／斷線等「結果未知」的人工重試沿用該鍵，
直到同鍵重送或既有查詢確認結果。結果未知時不能以換鍵解決錯誤，也不能把修改後的 payload
塞進舊鍵。取得明確的成功或拒絕結果後，該次操作結束；使用者再主動發起的合法新操作
使用新鍵，即使按鈕沒有表單、payload 相同也是如此。例如 ERP 重送已獲確認後，
下一次明確要求重送是一個新操作；前次 HTTP 回應遺失則仍是同一個操作。
Query invalidation 只重查讀取，不能重送 command。

快取只放記憶體。登入／登出／帳號或 API token 變更時，在新身分可顯示資料之前，
取消舊查詢並清除舊快取；晚到的舊回應不能重新填回新身分的 cache。
cache key 與日誌不能包含 token 或密碼。保留 prefixed CSRF cookie 的既有優先序。

先在商品頁驗證讀寫流程，再分組推廣。頁面既有測試應測行為，不鎖定 hook 的實作細節。

### 4. Browser-safe HTTP 契約

Ticket 81 只收斂 Order 及其畫面需要的相關型別。後端權威來源推導瀏覽器的序列化型別，
Admin 可以使用明確的欄位投影；不要求把 API 回傳的所有欄位都顯示出來。
狀態與 adjustment source 不再各維護一份手寫 union。

序列化契約由 `packages/commerce/order` 擁有，以 browser-safe type-only export／subpath
供 Admin 使用；必要純契約拆檔仍放在 order。Commerce Order 型別不移入領域中立的
`packages/platform/contracts`，Admin 也不從會帶入 runtime 的 Order barrel 取得契約。

後端 DTO 的 Date 經 JSON 成為字串，不能把 `OrderDto` 直接當瀏覽器型別。
type-only 的依賴接線仍要通過 Admin 獨立 tsconfig、Vitest 與 Vite。
瀏覽器 bundle 不得因此拉入 Nest、Drizzle、pg 或 Node runtime；既有 HTTP JSON shape 維持不變。

補上 awaiting_payment 的三語標示、篩選與待付款分類，以及 reward adjustment 的安全顯示。
可執行動作以現有後端契約為準；不順便更改付款、取消或退款規則。
metadata 目前只輸出 command/query 輸入 schema，這一輪不建完整 OpenAPI／SDK 產生器。

### 5. 表格、表單與既有功能

本輪統一基本 Table、欄位、按鈕與錯誤外觀，保留後端的 limit／offset 和既有篩選能力。
不能把「本頁資料」顯示成全站統計，不能替後端未支援的排序加出誤導控制項。
金額單位、百分比／基點、空字串與 null、部分 PATCH、日期時區和原因必填規則均維持。

TanStack Table：出現已確認的排序、欄位顯隱、列選取需求時再開實作票。
React Hook Form：以重複或複雜驗證有明確節省為觸發條件；目前不為換樣式全面搬表單 state。
保留既有 Zod、react-day-picker、Intl、i18n 與 hash router；Lucide 全面換圖示、富文本編輯器、
圖表套件、全域 state library、共享 UI package 均不在本輪。

### 6. ForgeFlowv2 後續整合

已知：使用者自行開發 ForgeFlowv2，希望未來導入。尚未確認其 repo、版本、責任、
執行方式與對外契約，不能推定它是 workflow engine、UI library 或工作佇列替代品。

Ticket 91 是獨立 discovery：取得來源與預期場景後，判定可否沿用既有 UI、
HTTP 或 build-time Extension 接縫，記錄認證、版本、失敗處理、冪等、
部署與 rollback 證據，再提出另一份可審查 spec。
本輪不新增 ForgeFlowv2 dependency、空 adapter、預留 endpoint、事件、資料表或設定。

## Acceptance Criteria

- [x] Order 的 awaiting_payment 與 reward adjustment 有契約及 UI regression coverage，日期型別符合 JSON。
- [x] 既有 16 routes 與 Login 可用；hash 導覽、頁首動作、三語、深淺色及資訊密度維持。
- [x] 所有現存共用選單與 modal／drawer 使用選定 primitives；焦點、Esc、鍵盤與可讀名稱有驗證。
- [x] 全部業務資料頁使用 Query；沒有遺留同一份 server state 的 effect／reloadKey 平行實作。
- [x] 商品、訂單、會員、物流、退款／RMA、發票與作業重送仍走既有 api.*，不增加 command 呼叫次數。
- [x] 查詢參數變更、失敗、空資料、儲存後更新與身分切換不顯示錯誤或前一身分資料。
- [x] 無 DB migration、公開 API 改動、後端 framework 改造或 ForgeFlowv2 speculative runtime。
- [x] 已無使用者的舊互動／CSS 已刪除；仍保留的頁面特有樣式與語意元件有明確用途。
- [x] 後台 build、型別、元件測試與 repository CI 通過；瀏覽器鍵盤與視覺驗證有具體紀錄。

## Delivery Order and Review

| Ticket | 交付 | 前置 |
| --- | --- | --- |
| [81](../tickets/81-admin-order-http-contract.md) | 收斂後台 Order HTTP 型別與待付款顯示 | — |
| [82](../tickets/82-admin-shadcn-primitives.md) | 建立 shadcn 基礎並替換共用選單與理由對話框 | — |
| [83](../tickets/83-admin-products-ui-pilot.md) | 以商品頁完成 shadcn UI 垂直試點 | 82 |
| [84](../tickets/84-admin-marketing-content-ui.md) | 遷移促銷、券、會員設定與品牌內容 UI | 83 |
| [85](../tickets/85-admin-commerce-operations-ui.md) | 遷移訂單、會員、RMA 與出貨工作台 UI | 81, 83 |
| [86](../tickets/86-admin-shell-and-observability-ui.md) | 遷移後台外殼、登入與其餘營運頁 UI | 83 |
| [87](../tickets/87-admin-query-foundation-products.md) | 建立 Query 與身分快取邊界並遷移商品讀寫 | 83 |
| [88](../tickets/88-admin-commerce-query-migration.md) | 收斂商務編輯與操作頁的 Query 狀態 | 81, 84, 85, 87 |
| [89](../tickets/89-admin-operations-query-migration.md) | 收斂營運查詢、重送與外殼徽章的 Query 狀態 | 86, 88 |
| [90](../tickets/90-admin-migration-closure.md) | 完成後台遷移清理、文件與整體驗收 | 81, 84, 85, 86, 88, 89 |
| [91](../tickets/91-forgeflowv2-integration-discovery.md) | 釐清 ForgeFlowv2 整合責任與契約（discovery） | — |

Ticket 81–90 為本輪實作，建議按編號逐一交接；票內 Blocked by 表達真正相依，
並不是前一張編號一律阻擋下一張。81／82 可獨立，UI 批次與 Query foundation 也可在前置完成後分支進行，
但使用者目前選擇逐一執行，避免共用檔案衝突。

所有實作者指定 `gpt-5.6-terra / high`。81、85、87、88、89 與最終 90 需
`gpt-5.6-sol / high` 獨立審查契約、權限、快取或財務操作邊界；其他票由 Terra／high 獨立審查。
這是使用者本輪明確指定的實作模型；審查不授權實作者擴大後端或安全邊界。

每票留下 source、行為測試、相關文件與驗證結果；跨票擴大變更前先更新規格。
PR 合併、部署與 ForgeFlowv2 實作不由本輪建票自動授權。

## Verification and Rollback

- 每張程式票：`pnpm typecheck:admin`、`pnpm test:admin`、`pnpm build:admin`；
  先跑受影響的既有測試，再跑後台全套。
- 涉及共享契約、根依賴或接線時，加跑 `pnpm typecheck`、`pnpm test`。
- 依 `.github/workflows/ci.yml` 完成現有 CI；PostgreSQL integration 和部署 smoke
  需要對應環境，未跑就如實標示，不能用 admin tests 代替。
- UI 票用已授權的本機測試資料驗證 3 語 × 2 主題、360px／1280px、鍵盤開關與焦點返回；
  真實瀏覽器結果才可宣稱視覺／focus 驗收完成。
- rollback 以單票／頁面可回復的變更為單位；共享 foundation 已有依賴票時按相反相依順序回退。
  不使用破壞性 reset，不保留雙套 runtime 只為未來 rollback；無資料遷移。

## Sources

現況來源：`apps/admin/src/{App.tsx,api.ts,routes.tsx,router.ts,main.tsx}`、
`apps/admin/src/components/{RowMenu,ReasonDialog,DateField,DateTimeField}.tsx`、
`apps/admin/src/pages`、`packages/commerce/order/src/dto.ts`、`apps/admin/DESIGN.md`、
`docs/architecture.md`、`apps/api/src/controllers/meta.controller.ts`。

2026-09-06 查證：
- [shadcn/ui 的 source distribution 與維護責任](https://ui.shadcn.com/docs)
- [既有 Vite 專案安裝](https://ui.shadcn.com/docs/installation/vite)
- [Data Table 是 TanStack Table 組裝指南](https://ui.shadcn.com/docs/components/base/data-table)
- [React Hook Form 整合](https://ui.shadcn.com/docs/forms/react-hook-form)
- [TanStack Query server state](https://tanstack.com/query/latest/docs/framework/react/overview)
- [Refine＋shadcn/ui](https://refine.dev/core/docs/ui-integrations/shadcn/introduction/)
- [Shadcn Admin Kit data provider](https://marmelab.com/shadcn-admin-kit/docs/dataproviders/)

整套 admin framework 在本輪暫緩：既有 API 同時包含資源查詢與具名商務 command，
全面搬遷需要額外接合 data、auth 與 router；漸進採用元件與 Query 即可處理目前已證實的重複工作。

## Completion evidence（2026-09-07）

[Ticket90](../tickets/90-admin-migration-closure.md) 收錄逐票 rollback、最終 source hashes、完整 CI 與瀏覽器驗收。Admin314／root561／integration505、兩者typecheck／Adminbuild、Docker62／native61全通過；16routes＋Login204layout、shell12、Productdialogs36及三語phase3通過。Sol/high Standards／Spec零發現。基底Spec0009仍依B00–B17另行完成；本規格結案不代表Base已實作。
