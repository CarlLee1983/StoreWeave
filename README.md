# StoreWeave

目標定位與完整基底規劃見 [Spec 0009](docs/specs/0009-complete-modular-base.md)；
能力盤點、套件策略與派工順序見 [Base 執行計畫](docs/base-implementation-plan.md)。
以下介紹目前已實作的 Commerce 產品，不代表通用基底目標已完成。

單站獨立部署的電商平台。每個客戶獨立建置、獨立部署、使用獨立資料庫，
但共用同一套 Commerce Core：**品牌差異用 Theme，特殊需求用 Extension，Core 永遠不改**。

概念接近 WordPress 的 Core + Theme + Plugin，差別在於 Extension 不能改核心、
不能碰其他模組的資料表、也不能在正式主機上動態安裝。

```
Interface Adapter   REST · Storefront(SSR) · Admin(React) · MCP · CLI
                              |  全部走同一組 handler
Application         Command Bus · Query Bus  -- 授權 / Zod 驗證 / Idempotency / Audit
                              |
Domain              catalog · inventory · order · cart · promotion ⋯     <- Commerce Core
                              |  版本化 Domain Event
Integration         Transactional Outbox -> Worker -> Extension（金流 / 物流 / 發票 / 通知 / ERP / MCP）
                              |
Infrastructure      PostgreSQL（唯一必要依賴；Redis 選配）
```

## 快速開始

Docker（一條指令啟動 PostgreSQL + API + Worker）：

```bash
docker compose up -d
# Storefront   http://localhost:3000
# 管理後台      http://localhost:3000/admin
# MCP 端點      http://localhost:3000/mcp
```

本機開發（需要 Node.js 22 以上、pnpm 12 以上，以及自備一個 PostgreSQL）：

pnpm 的版本釘在 `package.json` 的 `packageManager`（目前 `pnpm@12.0.0`），
CI 與 Docker 建置都以它為準。用 Corepack（`corepack enable pnpm`）就不必自己裝：
它會依那一行取用對應的版本。獨立安裝的 pnpm 則要自己是 12 以上——pnpm 12 起
`pnpm-lock.yaml` 會把這個釘選版本記成 `packageManagerDependencies`，舊版
pnpm 讀到會判定 lockfile 過期，CI 的 `--frozen-lockfile` 直接失敗。

**pnpm 10 以下跑不起來**：設定從 `.npmrc` 搬到了 `pnpm-workspace.yaml`
（`nodeLinker` / `shamefullyHoist`），舊版讀不到那些鍵，症狀是 `fastify`
這類靠提升才看得到的傳遞相依整批解析不到。pnpm 12 起這類鍵不再靜靜忽略：
釘選版本與執行版本相符時，`pnpm-workspace.yaml` 裡任何不認得的設定會直接以
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` 中止安裝。

```bash
pnpm install
export DATABASE_URL=postgres://commerce:devpw@127.0.0.1:5432/commerce
export COMMERCE_SIGNING_KEY_K1=$(openssl rand -base64 32) DEMO_ERP_API_KEY=dev-erp-key
export COMMERCE_CONFIG=deployments/example-store/commerce.yaml
pnpm commerce migrate
pnpm seed -- --demo  # 明確選擇示範資料：注入 24 款選品、促銷券、會員等級與示範帳號
pnpm "dev:api"       # 另開一個終端機
pnpm "dev:worker"    # 需要 API token 時：pnpm commerce token:create --name dev --role admin
```

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) | **全功能 Demo 演示指南（示範帳號、前台體驗、折扣碼測試與後台操作）** |
| [docs/architecture.md](docs/architecture.md) | 模組邊界、Command/Query/Event 流向、目錄結構 |
| [apps/admin/DESIGN.md](apps/admin/DESIGN.md) | 管理後台設計系統與資料／互動邊界 |
| [docs/extension-development.md](docs/extension-development.md) | Extension SDK 十項契約與完整開發範例 |
| [docs/deployment-docker.md](docs/deployment-docker.md) | Docker 安裝與維運 |
| [docs/deployment-native.md](docs/deployment-native.md) | 原生 Ubuntu / Debian 安裝、升級與回退 |
| [docs/ecpay-and-shipping.md](docs/ecpay-and-shipping.md) | 綠界付款、泛用回呼與台灣配送方式設定 |
| [packages/themes/default/DESIGN.md](packages/themes/default/DESIGN.md) | 顧客前台體驗、字型交付與可下單呈現規格 |
| [docs/operations.md](docs/operations.md) | `commerce` CLI、健康端點、備份還原 |
| [docs/adr/](docs/adr/) | 架構決策紀錄；`README.md` 是它自己的索引 |
| [docs/specs/](docs/specs/) | 功能規格與交付順序 |
| [docs/tickets/](docs/tickets/) | 工單與已知、刻意沒做的取捨 |
| [docs/frontend-page-plan.md](docs/frontend-page-plan.md) | 顧客前台的頁面資訊架構 |
| [docs/runbooks/](docs/runbooks/) | 上線與維運的逐步程序 |
| [docs/research/](docs/research/) | 對外部 API 的查證紀錄 |

## 三條垂直流程

1. **商品與庫存** — 建立商品 → 查詢 → 調整庫存 → 產生 `commerce.product.created.v1` 與
   `commerce.inventory.adjusted.v1`，權限與 Idempotency Key 全程強制。
2. **訂單** — 建立訂單（同一交易內扣庫存）→ Mock Payment 收款 → `commerce.order.paid.v2`
   與訂單狀態寫進**同一個交易**的 Outbox → Worker 可靠處理，重複處理不產生重複外部副作用。
3. **Extension** — Demo ERP 訂閱 `commerce.order.paid.v2`，轉成 ERP 單據後以背景工作送出，
   記錄成功／失敗／重試次數／最後錯誤，並提供人工重送 Command；MCP Extension 以
   `search_products` / `get_order` / `get_sales_summary` / `adjust_inventory` 四個工具公開能力，
   **只能**經由 Command Bus 與 Query Bus。

## 測試

| 指令 | 內容 |
| --- | --- |
| `pnpm typecheck` | 全 workspace 型別檢查 |
| `pnpm typecheck:admin` | 管理後台的型別檢查（另一份 tsconfig） |
| `pnpm test` | 單元 + 架構測試（不需要 Docker） |
| `pnpm test:admin` | 管理後台的 React 元件測試（jsdom） |
| `pnpm build:admin` | 管理後台 Vite production build |
| `pnpm test:integration` | PostgreSQL 整合測試（Testcontainers，需要 Docker） |
| `pnpm test:all` | 以上三組測試 |
| `pnpm smoke:docker` | Docker Compose 端到端 smoke test |
| `pnpm smoke:native` | 在乾淨的 Debian 容器安裝 tarball 並跑端到端 smoke test |

## 邊界（由測試強制，不只是文件）

- Commerce Core 不含任何客戶名稱或 `if (customer === ...)`。
- Extension 拿不到資料庫連線、交易物件，也讀不到其他 Extension 的資料。
- Extension 註冊的 Command / Query / Job 一律在 `ext.<id>.*` 命名空間，且必須與 manifest 完全一致。
- MCP 工具的型別只能指向 Command 或 Query —— 直接存取資料庫是「寫不出來」，不是「不該做」。
- 公開契約一律是 DTO + Zod schema，ORM entity 不外流。

`tests/architecture/boundaries.test.ts` 會逐項檢查以上規則，
`.github/workflows/ci.yml` 則在每次 push 與 PR 上跑兩份型別檢查、上表的三組測試，
以及兩條部署路徑的 smoke test。
