---
description: 按執行入口、平台能力、產品組裝與業務模組查找 StoreWeave 程式碼。
pageClass: architecture-page
---

# 程式碼地圖

這份索引保留架構中的目錄與責任說明，適合已知道要改什麼、正在找擁有者時使用。先判斷問題落在入口、共用機制、產品規則還是產品組裝，再沿著對應目錄追下去；同一個使用者操作往往會經過其中好幾層。

## 從需求找到擁有者

| 想處理的變更 | 先看哪裡 | 接著確認什麼 |
| --- | --- | --- |
| HTTP 路徑、請求或回應轉換 | `apps/api` 與所選 Release 的 server projection | adapter 呼叫哪個 Command／Query；業務規則應回到 handler |
| 訂單、住宿供應或訂位規則 | `packages/commerce`、`packages/booking` 或 `packages/dining` | 模組公開 service、資料 ownership、相關測試與契約 |
| 換產品、選模組或增加產品頁面 | `packages/releases/<release>` 與模組的 contribution | 各 target projection 是否完整，以及產物是否排除未選模組 |
| 前台品牌與版型 | `packages/themes` | 模組提供的頁面資料與 renderer 契約 |
| 第三方金流、物流或 ERP | `packages/extensions` | SDK／Provider 契約，以及 Release 是否將它編入 |
| 共用授權、交易或背景工作 | `packages/platform` 中對應能力 | 是否影響所有選用它的 Release |
| 維運命令與交付範本 | `tools/cli`、`deployments` | 共用流程與產品提供的名稱、設定及路徑 |

例如「下單時庫存不足卻成功」應從 Commerce 的 order／inventory 流程追查；「所有 Command 的授權順序錯誤」才應追到平台 CommandBus。要進一步理解邊界，先讀[平台、產品與 Release](platform-and-products.md)，不要只靠資料夾名稱決定修改位置。

## 應用入口：誰接收請求、誰執行背景工作？

| 目錄 | 責任 |
| --- | --- |
| [`apps/api/`](../../apps/api/) | NestJS + Fastify：REST、Storefront SSR、Admin 靜態資源、MCP 端點 |
| [`apps/worker/`](../../apps/worker/) | 背景工作行程：Outbox 轉送與工作佇列 |
| [`apps/admin/`](../../apps/admin/) | React 管理後台；由 Vite 建置成靜態資源，封裝進 Release |

入口負責把外部操作轉進共用 Runtime。看到 REST Controller 並不代表業務資料由 Controller 擁有；相同 handler 也可能由 CLI、MCP 或 Worker 使用。

## 平台：契約、資料與執行機制

下列目錄都位於 [`packages/platform/`](../../packages/platform/)。kernel 是其中的組裝者，不是所有共用程式的容器。

| 子目錄 | 責任 |
| --- | --- |
| `contracts/` | Actor、Command／Query descriptor、DomainEvent、錯誤型別；無相依 |
| `config/` | 設定檔 schema、載入器、Secret Provider；第一版檔名仍是 `commerce.yaml`，其他 Release 的檔名由其組裝提供 |
| `db/` | Database（Drizzle + pg）、migration runner、平台資料表 |
| `command-bus/` | 唯一寫入入口：授權 → 驗證 → Idempotency → 交易 → Audit → Outbox |
| `query-bus/` | 唯一讀取入口 |
| `event-bus/` | 事件目錄與訂閱登記，不做即時派送 |
| `release/` | ReleaseDefinition、target projections、bootstrap 與組裝契約檢查 |
| `outbox/` | Transactional Outbox |
| `jobs/` | PostgreSQL 背景工作佇列：SKIP LOCKED、退避重試、dedupeKey |
| `authorization/` | 權限登記、Policy Registry、角色映射 |
| `audit/` | Audit Log 寫入與機密遮蔽 |
| `extension-sdk/` | Extension 的唯一公開介面；使用方式見[Extension 開發](../extension-development.md) |
| `kernel/` | Runtime、ExtensionHost、Worker、健康檢查、Theme 契約，以及平台自身的維運模組（`platform.jobs.*` 死信佇列，見 [ADR 0011](../adr/0011-platform-ops-module.md)） |

## 平台：身分與可選的共用能力

| `packages/platform/` 子目錄 | 責任 |
| --- | --- |
| `identity/` | 帳號、session、簽發式身分連結（重設／驗證／換信箱）、API token 與後台第二因素；見 [ADR 0012](../adr/0012-operator-identity.md)、[0014](../adr/0014-customer-identity.md)、[0041](../adr/0041-base-accounts-are-not-commerce-customers.md)–[0044](../adr/0044-operator-mfa-is-totp-with-recovery-codes.md) |
| `auth/` | Release 可選取的登入、註冊、登出與密碼重設頁面 |
| `crypto/` | 簽章、封裝與金鑰環：`sw1.`／`swe1.` 與依用途推導的子金鑰；見 [ADR 0038](../adr/0038-signed-values-carry-a-key-id.md) |
| `cache/` | PostgreSQL 快取與跨程序互斥鎖 |
| `storage/` | 物件儲存：本機與 S3 相容 adapter；見 [B09](../base/b09/acceptance.md) |
| `mail/` | SMTP 寄送、模板快照與佇列；見 [B06](../base/b06/acceptance.md) |
| `notifications/` | 領域中立的通知、投遞、重試與站內收件匣能力 |
| `media/` | 使用者媒體、preview、處理狀態與引用紀錄 |
| `site/` | 網站設定、導覽與首頁 page declaration |
| `content/` | 品牌內容與聯絡訊息；Base 與 Commerce Release 都可選用 |
| `http-client/` | 對外 HTTP 呼叫：受信任目的地檢查與 client |
| `i18n/` | 訊息、金額與時間格式化，以及 HTML 跳脫 |

Account 與 Customer 的資料分工要沿用領域詞彙：identity 擁有可登入的帳號，Commerce customer 才擁有商務顧客資料。通知也分兩層：平台 notifications 提供投遞能力，產品模組提供業務事件、觸發時機與內容。

## Release：哪些能力會真的進入產品？

| 目錄 | 責任與目前限制 |
| --- | --- |
| [`packages/releases/base/`](../../packages/releases/base/) | Base runtime 與 server／worker／Admin／CLI／config projections |
| [`packages/releases/commerce/`](../../packages/releases/commerce/) | Commerce runtime、module／extension catalog 與 target projections |
| [`packages/releases/booking/`](../../packages/releases/booking/) | Booking runtime、module／extension catalog 與 target projections |
| [`packages/releases/dining/`](../../packages/releases/dining/) | Dining Release 設定；目前只有 config projection，尚未登記於 `scripts/releases.mjs` |

某個 package 存在於 repository，不代表它會進入每份產物。查看 Release 的選取與 target projection，才能判斷目前產品會載入哪些能力；可建置狀態見[平台與產品章節](platform-and-products.md#目前哪些-release-可以建置)。

## 產品模組與 Extension

| 目錄 | 責任 |
| --- | --- |
| [`packages/commerce/`](../../packages/commerce/) | 第一個產品的 Product Modules：`cart`、`catalog`、`coupon`、`customer`、`inventory`、`invoice`、`loyalty`、`notification`、`order`、`promotion`、`refund`、`rma`、`shipping` |
| [`packages/booking/`](../../packages/booking/) | 第二個產品的 Product Modules：`property`、`availability`、`reservation` |
| [`packages/dining/`](../../packages/dining/) | 第三個產品的 Product Modules；目前只有 `reservation`，[Spec 0012](../specs/0012-dining-product-release.md) 實作中 |
| [`packages/extensions/`](../../packages/extensions/) | 金流（`mock-payment`／`ecpay`）、物流（`ecpay-logistics`）、發票（`mock-invoice`／`ecpay-invoice`）、ERP（`demo-erp`）與 `mcp` |
| [`packages/examples/`](../../packages/examples/) | 入門 `notes` 與進階 `file-requests`；先走[從零開發教學](../learn/from-zero/index.md)，再查[模組開發](../module-development.md) |

Extension 實際編入 Commerce Release 的清單以 [`packages/releases/commerce/src/modules.ts`](../../packages/releases/commerce/src/modules.ts) 為準，建置時組裝的理由見 [ADR 0002](../adr/0002-build-time-extension-assembly.md)。

**通知不是 Extension。** 共用通知是 `@storeweave/notifications`（module `platform-notifications`），位於 `packages/platform/notifications`。不要把它與 Commerce 的 `notification` 產品模組混成同一層責任。

## Theme、CLI 與部署資料

| 目錄 | 責任 |
| --- | --- |
| [`packages/themes/base/`](../../packages/themes/base/) | Base Storefront Theme |
| [`packages/themes/default/`](../../packages/themes/default/) | 預設 Storefront Theme；純 SSR 表單，不載入 JavaScript |
| [`packages/themes/booking-default/`](../../packages/themes/booking-default/) | Booking Storefront Theme |
| [`tools/cli/`](../../tools/cli/) | 共用 CLI 流程；名稱與設定由所選 Release 提供 |
| [`deployments/`](../../deployments/) | `example-store`、`example-store-two`、systemd unit 與設定 JSON Schema |

Theme 決定呈現，CLI 與部署資料決定如何操作及交付應用。修改產品名稱、設定位置或服務名稱時，應先確認 Release 提供的值，再檢查相應部署範本。

回到[架構總覽](../architecture.md)。
