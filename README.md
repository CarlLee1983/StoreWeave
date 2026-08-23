# StoreWeave

單站獨立部署的電商平台。每個客戶獨立建置、獨立部署、使用獨立資料庫，
但共用同一套 Commerce Core：**品牌差異用 Theme，特殊需求用 Extension，Core 永遠不改**。

概念接近 WordPress 的 Core + Theme + Plugin，差別在於 Extension 不能改核心、
不能碰其他模組的資料表、也不能在正式主機上動態安裝。

```
Interface Adapter   REST · Storefront(SSR) · Admin(React) · MCP · CLI
                              |  全部走同一組 handler
Application         Command Bus · Query Bus  -- 授權 / Zod 驗證 / Idempotency / Audit
                              |
Domain              catalog · inventory · order          <- Commerce Core
                              |  版本化 Domain Event
Integration         Transactional Outbox -> Worker -> Extension（ERP / 金流 / MCP）
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

本機開發（需要 Node.js 22 以上、pnpm 11 以上，以及自備一個 PostgreSQL）：

pnpm 的版本釘在 `package.json` 的 `packageManager`（目前 `pnpm@11.22.0`），
CI 與 Docker 建置都以它為準。用 Corepack（`corepack enable pnpm`）就不必自己裝：
它會依那一行取用對應的版本。獨立安裝的 pnpm 則要自己是 11 以上。

**pnpm 10 以下跑不起來**：設定從 `.npmrc` 搬到了 `pnpm-workspace.yaml`
（`nodeLinker` / `shamefullyHoist`），舊版讀不到那些鍵，症狀是 `fastify`
這類靠提升才看得到的傳遞相依整批解析不到。

```bash
pnpm install
export DATABASE_URL=postgres://commerce:devpw@127.0.0.1:5432/commerce
export COMMERCE_ADMIN_TOKEN=dev-admin-token COMMERCE_MCP_TOKEN=dev-mcp-token DEMO_ERP_API_KEY=dev-erp-key
export COMMERCE_CONFIG=deployments/example-store/commerce.yaml
pnpm commerce migrate
pnpm "dev:api"      # 另開一個終端機
pnpm "dev:worker"
```

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 模組邊界、Command/Query/Event 流向、目錄結構 |
| [docs/extension-development.md](docs/extension-development.md) | Extension SDK 十項契約與完整開發範例 |
| [docs/deployment-docker.md](docs/deployment-docker.md) | Docker 安裝與維運 |
| [docs/deployment-native.md](docs/deployment-native.md) | 原生 Ubuntu / Debian 安裝、升級與回退 |
| [packages/themes/default/DESIGN.md](packages/themes/default/DESIGN.md) | 顧客前台體驗、Google 字體交付與可下單呈現規格 |
| [docs/operations.md](docs/operations.md) | `commerce` CLI、健康端點、備份還原 |
| [docs/adr/](docs/adr/) | 架構決策紀錄（11 篇） |

## 三條垂直流程

1. **商品與庫存** — 建立商品 → 查詢 → 調整庫存 → 產生 `commerce.product.created.v1` 與
   `commerce.inventory.adjusted.v1`，權限與 Idempotency Key 全程強制。
2. **訂單** — 建立訂單（同一交易內扣庫存）→ Mock Payment 收款 → `commerce.order.paid.v1`
   與訂單狀態寫進**同一個交易**的 Outbox → Worker 可靠處理，重複處理不產生重複外部副作用。
3. **Extension** — Demo ERP 訂閱 `commerce.order.paid.v1`，轉成 ERP 單據後以背景工作送出，
   記錄成功／失敗／重試次數／最後錯誤，並提供人工重送 Command；MCP Extension 以
   `search_products` / `get_order` / `get_sales_summary` / `adjust_inventory` 四個工具公開能力，
   **只能**經由 Command Bus 與 Query Bus。

## 測試

| 指令 | 內容 |
| --- | --- |
| `pnpm test` | 單元 + 架構測試（不需要 Docker） |
| `pnpm test:admin` | 管理後台的 React 元件測試（jsdom） |
| `pnpm test:integration` | PostgreSQL 整合測試（Testcontainers，需要 Docker） |
| `pnpm test:all` | 以上兩者 |
| `pnpm smoke:docker` | Docker Compose 端到端 smoke test |
| `pnpm smoke:native` | 在乾淨的 Debian 容器安裝 tarball 並跑端到端 smoke test |

## 邊界（由測試強制，不只是文件）

- Commerce Core 不含任何客戶名稱或 `if (customer === ...)`。
- Extension 拿不到資料庫連線、交易物件，也讀不到其他 Extension 的資料。
- Extension 註冊的 Command / Query / Job 一律在 `ext.<id>.*` 命名空間，且必須與 manifest 完全一致。
- MCP 工具的型別只能指向 Command 或 Query —— 直接存取資料庫是「寫不出來」，不是「不該做」。
- 公開契約一律是 DTO + Zod schema，ORM entity 不外流。

`tests/architecture/boundaries.test.ts` 會逐項檢查以上規則，
`.github/workflows/ci.yml` 則在每次 push 與 PR 上跑完型別檢查、四組測試與兩條部署路徑的 smoke test。
