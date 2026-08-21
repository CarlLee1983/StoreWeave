# Architecture Decision Records

| # | 決策 | 狀態 |
| --- | --- | --- |
| [0001](0001-modular-monolith.md) | 以 Modular Monolith 為第一版架構 | accepted |
| [0002](0002-build-time-extension-assembly.md) | Extension 採建置時組裝，不支援執行期上傳 | accepted |
| [0003](0003-postgres-required-redis-optional.md) | PostgreSQL 為必要依賴，Redis 為選配 | accepted |
| [0004](0004-mcp-is-an-interface-adapter.md) | MCP 只是一種 Interface Adapter | accepted |
| [0005](0005-data-ownership.md) | Extension 資料與 Core 資料的所有權規則 | accepted |
| [0006](0006-event-versioning.md) | 事件版本與相容性政策 | accepted |
| [0007](0007-shared-artifact-deployment.md) | Native 與 Docker 共用同一份 Application Artifact | accepted |
| [0008](0008-build-tooling-and-migrations.md) | 以 esbuild 打包、SQL migration 內嵌於 TypeScript | accepted |
| [0009](0009-async-payment-and-inventory-reservation.md) | 非同步付款與庫存預留 | accepted |
| [0010](0010-platform-is-domain-agnostic.md) | 平台對領域中立，Commerce 是產品不是 kernel | accepted |
| [0011](0011-platform-ops-module.md) | 死信佇列由平台維運模組公開，重送與 requeue 分家 | accepted |

寫法：`**Falsified if:**` 段落裡用反引號標出這個決策所依賴的檔案，那些檔案就是這個決策的邊界清單。
