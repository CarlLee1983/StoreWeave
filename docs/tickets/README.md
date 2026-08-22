# 工單

由 `docs/specs/` 的五份規格拆出，共 49 張，依相依順序編號。詞彙見根目錄 `CONTEXT.md`，
決策見 `docs/adr/`（本批為 0013、0014、0015，並補充了 0009）。

**已完成**：01–23、25–49。定價引擎、顧客身分、購物車、優惠券與行銷碼、
購物金與會員等級、行銷分析頁都已落地。

**唯一還沒做的是 24（舊版訂單事件下線）**。使用者 2026-08-22 決定「先不要，
等一個 minor 週期」：repo 內已無訂閱者（demo-erp 於工單 23 遷到 `paid.v2`），
但外部部署未知。代價是過渡期每張訂單多發 3 筆 outbox。要下線前再問一次。

**這一批拍板的預設值**（2026-08-22）：限量券搶輸時整張單失敗（不是靜默不套用）；
購物金回饋 1%、付款後 7 天生效、發放後 365 天到期。理由記在對應的工單檔末段。

**09 → 13 → 15 → 23 → 24 是一組 expand–contract**。訂單總額的語意變更會波及正在運作的
ERP 串接與後台，因此先加恆為零的欄位、再讓新舊事件並行、接上定價引擎、下游遷移，
最後才拆掉舊版。每一步 CI 都能綠。其餘工單都是可獨立驗證的垂直切片。

**兩個既有缺陷各自歸位**：訂單越權讀取修在 12，結帳重複送出建出多張訂單修在 28。

| # | 標題 | 阻擋於 |
| --- | --- | --- |
| [01](01-sales-summary-regression-net.md) | 營收摘要的現況迴歸測試網 | — |
| [02](02-admin-route-table.md) | Admin 路由表重構 | — |
| [03](03-recurring-job-convention.md) | 週期性工作的自我續排慣例 | — |
| [04](04-pricing-engine-skeleton.md) | 定價引擎骨架與滿額折固定金額 | — |
| [05](05-actor-type-customer.md) | Actor 型別新增顧客，並收斂前台角色 | — |
| [06](06-notification-provider.md) | 通知 Provider 與開發用實作 | — |
| [07](07-pricing-rules-percentage.md) | 百分比規則與活動的優先序與疊加 | 04 |
| [08](08-adjustment-allocation.md) | 價格調整分攤到商品行 | 04 |
| [09](09-order-money-columns-expand.md) | 訂單金額欄位擴充（行為不變） | 01 |
| [10](10-promotion-crud.md) | 促銷活動的建立與管理 | 04 |
| [11](11-public-guard-three-stage.md) | 前台守衛改為三段式 | 05 |
| [12](12-order-scope-by-actor.md) | 訂單查詢依身分限縮範圍 | 05 |
| [13](13-order-events-expand.md) | 訂單事件發出新版本（新舊並行） | 09 |
| [14](14-customer-signup-login.md) | 顧客註冊、登入與登出 | 11 |
| [15](15-checkout-applies-pricing.md) | 下單套用定價引擎 | 07, 08, 13 |
| [16](16-quote-query.md) | 結帳前試算 | 07, 08, 10 |
| [17](17-admin-promotions-page.md) | 後台促銷活動頁 | 02, 10 |
| [18](18-password-reset.md) | 密碼重設與改密碼撤銷 session | 06, 14 |
| [19](19-customer-profile.md) | 顧客個人資料與收件地址 | 14 |
| [20](20-customer-order-history.md) | 會員中心：我的訂單 | 12, 14 |
| [21](21-order-actor-owned.md) | 下單者由身分決定 | 14 |
| [22](22-admin-customers-page.md) | 後台會員頁 | 02, 14 |
| [23](23-downstream-migration.md) | 下游遷移到新的金額語意 | 15 |
| [24](24-order-events-contract.md) | 舊版訂單事件下線 | 23 |
| [25](25-cart-module.md) | 購物車與訪客識別 | 11 |
| [26](26-cart-quote.md) | 購物車即時試算 | 16, 25 |
| [27](27-cart-merge.md) | 登入時合併購物車 | 14, 25 |
| [28](28-cart-checkout.md) | 購物車結帳轉單 | 15, 21, 25 |
| [29](29-storefront-cart-pages.md) | 前台購物車與結帳頁 | 26, 28 |
| [30](30-guest-cart-cleanup.md) | 訪客購物車清理 | 03, 25 |
| [31](31-coupon-shared-codes.md) | 優惠券模型與公開共用碼 | 10, 28 |
| [32](32-coupon-limits-concurrency.md) | 限量與每人限用一次 | 31 |
| [33](33-issued-coupons.md) | 實發券、券碼產生與批次發放 | 31 |
| [34](34-coupon-on-signup.md) | 新會員註冊自動發券 | 14, 33 |
| [35](35-birthday-coupon.md) | 生日禮券 | 03, 33 |
| [36](36-marketing-codes-attribution.md) | 行銷碼與訂單歸因 | 31 |
| [37](37-coupon-reversal.md) | 訂單取消時券回沖 | 31 |
| [38](38-storefront-coupon-ui.md) | 前台券的使用與我的券 | 29, 33 |
| [39](39-admin-coupons-page.md) | 後台券管理 | 02, 33 |
| [40](40-reward-points-ledger.md) | 購物金帳本與付款後入帳 | 14, 15 |
| [41](41-points-redemption.md) | 結帳折抵購物金 | 28, 40 |
| [42](42-points-reversal.md) | 訂單取消時購物金回沖 | 40, 41 |
| [43](43-tier-points-ledger.md) | 等級積分帳本與會員等級 | 40 |
| [44](44-tier-recalculation.md) | 等級定期重算 | 03, 43 |
| [45](45-tier-benefits.md) | 等級的實質待遇 | 10, 43 |
| [46](46-manual-point-adjustment.md) | 後台手動調整購物金與積分 | 40, 43 |
| [47](47-analytics-page.md) | 行銷分析頁 | 01, 02, 31, 40 |
| [48](48-points-expiry-notice.md) | 購物金到期通知 | 03, 06, 40 |
| [49](49-storefront-points-ui.md) | 前台購物金與等級呈現 | 29, 40, 43 |

## 已知、刻意沒做的

這一批做完之後仍然成立的取捨，寫在這裡免得下一個人以為是漏掉的：

- **購物車每次渲染都讀整本購物金帳，而且商品行是 N+1**（`cart/src/service.ts`）。
  帳本長度目前是「訂單數 × 2」等級，可以接受。真的變慢時該做的是
  catalog／inventory 的批次查詢，以及一張定期結算的餘額快照，而不是把餘額改回欄位。
- **`listMyCoupons` 與 `promotionPerformance` 逐列查活動**。同上，先量再改。
- **`outstandingRewards` 是近似值**，理由寫在該函式的註解裡。要精確就得先有快照表。
- **取消訂單時扣回購物金不指名批次**，會扣到別批。今天走不到（累積在付款完成才發生，
  取消只允許 pending），部分退貨進模型時要一起處理。
- **`createPromotionInput` 以外的舊模組輸入仍未 `.strict()`**
  （catalog、inventory、customer、order 的部分 input）。那是既有行為，改動會影響
  現有客戶端，值得一張獨立的票。
