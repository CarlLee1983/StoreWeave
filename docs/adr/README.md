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
| [0016](0016-recurring-jobs-by-time-buckets.md) | 週期性工作用時間切片，不用自我續排的鏈 | accepted（排程機制部分由 0038 修訂） |
| [0017](0017-legacy-order-events-carry-net-total.md) | 舊版訂單事件在過渡期帶折扣後金額 | obsolete |
| [0018](0018-csrf-on-anonymous-write-endpoints.md) | 強制匿名的寫入端點以 Origin 檢查代替 CSRF token | accepted |
| [0019](0019-ledger-derived-balances.md) | 購物金與等級積分是分批帳本，餘額與等級是推導值 | accepted |
| [0020](0020-core-modules-subscribe-to-events.md) | Core 模組可以訂閱其他模組的事件 | accepted |
| [0021](0021-cross-module-foreign-keys.md) | 跨模組的參照不加外鍵，模組內的加 | accepted |
| [0022](0022-checkout-idempotency-key-is-server-derived.md) | 結帳的冪等鍵由伺服器從購物車識別碼導出 | accepted |
| [0023](0023-host-prefixed-cookies.md) | Cookie 名字帶 `__Host-` 前綴，有無由部署的協定決定 | accepted |
| [0024](0024-strict-command-inputs.md) | Command / Query 的輸入一律拒絕未知欄位 | accepted |
| [0025](0025-clawback-names-its-batch.md) | 扣回指名批次，是「先到期先用」的唯一例外 | accepted |
| [0026](0026-storefront-fonts-from-google-cdn.md) | 前台字型由 Google Fonts CDN 提供 | accepted（靜態資產部分由 0034 修訂） |
| [0027](0027-external-callbacks-belong-to-the-platform.md) | 外部回呼的端點屬於平台，Extension 沒有自己的 URL | accepted |
| [0028](0028-shipping-fees-are-not-priced-by-the-engine.md) | 運費與免運不經定價引擎，也不問物流商 | accepted |
| [0029](0029-shipping-is-a-module-payment-is-not.md) | 物流獨立成模組，付款留在 order | accepted |
| [0030](0030-awaiting-payment-and-variable-reservation.md) | `awaiting_payment` 與依付款方式而異的預留期限 | accepted |
| [0031](0031-shipment-events-are-domain-stages.md) | 出貨事件只表達領域階段，不轉述廠商狀態碼 | accepted |
| [0032](0032-product-status-transitions-are-not-enforced.md) | 商品狀態的合法轉換只在後台具名，command 不強制 | accepted |
| [0033](0033-brand-content-is-a-core-module.md) | 品牌內容是 Core 的 content 模組，Theme 只負責呈現 | accepted |
| [0034](0034-editorial-media-stays-theme-owned.md) | 編輯照片仍由 Theme 擁有，Core 只存一個封閉的圖片 key | accepted |
| [0035](0035-retain-postgres-queue-for-modular-base.md) | 完整 Base 沿用 PostgreSQL Queue，補齊可靠性契約 | proposed（B00） |
| [0036](0036-validate-module-composition-before-runtime.md) | 啟動前驗證模組組裝，分開初始化與操作相依 | accepted（B01） |
| [0037](0037-release-selection-and-history.md) | Release 統一選取模組，歷史驗證與啟用分開 | accepted（B02） |
| [0038](0038-signed-values-carry-a-key-id.md) | 簽發值帶 key id，金鑰依用途推導 | accepted（B12） |
| [0039](0039-cron-calculation-only-croner.md) | cron 時間運算用 croner，而且只用它的運算函式 | accepted（B05） |

寫法：每篇結尾用 `## Falsified if` 這個標題起一段，段落裡以反引號標出這個決策所依賴的檔案；
那些檔案就是這個決策的邊界清單，條件本身要寫成某個東西可以檢查的形式。
