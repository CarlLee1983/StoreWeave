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
| [0012](0012-operator-identity.md) | 後台操作者身分：自管帳號、cookie session，M2M token 維持現狀 | accepted |
| [0013](0013-marketing-is-a-commerce-module.md) | 行銷功能是 Commerce 模組，不是 Extension | accepted |
| [0014](0014-customer-identity.md) | 顧客身分：認證共用平台，顧客資料歸 Commerce | accepted |
| [0015](0015-order-money-model.md) | 訂單金額模型：Adjustment 必定分攤到 line，金額欄位一次補齊 | accepted |
| [0016](0016-recurring-jobs-by-time-buckets.md) | 週期性工作用時間切片，不用自我續排的鏈 | accepted |
| [0017](0017-legacy-order-events-carry-net-total.md) | 舊版訂單事件在過渡期帶折扣後金額 | accepted |

寫法：每篇結尾用 `## Falsified if` 這個標題起一段，段落裡以反引號標出這個決策所依賴的檔案；
那些檔案就是這個決策的邊界清單，條件本身要寫成某個東西可以檢查的形式。
