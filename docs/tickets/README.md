# 工單

由 `docs/specs/` 的五份規格拆出，共 49 張，之後補了第 50、51、52、53、54、55 張。依相依順序編號。詞彙見根目錄 `CONTEXT.md`，
決策見 `docs/adr/`（本批為 0013、0014、0015，並補充了 0009）。

**已完成**：01–56。定價引擎、顧客身分、購物車、優惠券與行銷碼、
購物金與會員等級、行銷分析頁都已落地。50 是後補的契約收斂票，51 與 52 是它做完之後
從「刻意沒做」那一段畢業的兩張：前者把 extension 的輸入也收進 ADR 0024，
後者修掉結帳沒帶 `cartId` 時的退路。53 補上「量得到自己」——那是三筆效能債的前置。
54 把「取消訂單扣回購物金會扣到別批」從下面那段「刻意沒做」畢業。
55 是做 54 的時候查出來的：`bus-timing` 那支整合測試在斷言一個由耗時決定的值——
交接文件裡那筆「至今沒有解釋」的 `test:all` 失敗就是它。

**57–67 的程式碼於 2026-08-25 全部落地**，Spec 0006 的購物營運閉環寫完了：57–62 是上線閉環
（結帳透明、ECPay 串接、綠界物流、超商選店、後台出貨、追蹤與通知），63–66 是售後與帳務，
67 是不阻擋出貨的商品探索改善。`typecheck` 乾淨、`test:all` 全綠（107 檔 1060 測）。

**68 與 69 於 2026-08-25 補上「寫好了卻點不到」的兩塊**：RMA 的審核流程原本只有 API client
方法、沒有頁面；發票模組原本連 HTTP 端點都沒有，開立失敗只能進資料庫看。現在兩者都有後台頁，
發票另外開了唯讀查詢端點與一個受限的重試入口——重試只在 `issue_failed` 與 `void_failed`
兩個狀態開放，因為「這張發票該開／該作廢」的決定屬於訂單與退款事件，不屬於店員。
做 69 的時候順手修掉一個真的 bug：job 記錄失敗用的冪等鍵只帶 `ctx.attempt`，手動重試會開新 job、
`attempt` 從 1 重來，於是第二次失敗被前一次的鍵吃掉、嘗試次數永遠停在 1。鍵改成帶上已記錄的次數。審查又擋下這個修法：以次數當鍵會在「job 根本沒能寫下失敗紀錄」時
（provider 丟例外、愛心碼被拒走 PermanentJobError）永遠停在同一把鍵，重試從此靜默失效；
更糟的是新鍵會與仍在退避中的自動重試並存，兩支 job 同時呼叫 provider 就會在綠界開出兩張發票。
最後改成以穩定的原始鍵 `replaceExisting` 重排同一支工作——不可能分裂成兩支——並讓重試也接受
`pending` 與 `void_pending`，否則例外失敗會留下一個沒有出口的狀態。

**70 是做 69 的時候查出來、但現在做不了的**：綠界的 `RelateNumber` 由固定 reference 推出，
「送出成功但回應遺失」之後每一次重送都會被判重複，而 provider 沒有查詢介面。同工單 64，
擋在商家開通上。

**71–75 來自 2026-08-25 的一次盤點**，找的是「命令寫好了、權限也發了，但沒有任何入口點得到」
這一種缺口——工單 68 與 69 補的正是它，盤點是問還有沒有別的。有四處：商品建得出來改不了
（`patchProduct` 與 PATCH 端點都在，`ProductsPage` 沒有編輯）；等級門檻與購物金倍率只能改
程式碼（五支命令零 HTTP 面）；通知投遞紀錄查不到（權限發了、端點沒有）；會員生日填錯無法
更正（命令的 summary 就寫著「客服代為修正」，但沒有 UI）。另外找到一支疑似死碼，開在 75。

盤點同時確認乾淨的部分：114 支 command/query 除上述外都有呼叫端，週期性工作那幾支由 job
正確觸發；31 篇 ADR 全部有 `Falsified if`，30 篇 accepted、1 篇 obsolete，沒有 proposed 卡著。

**71–75 於 2026-08-25 全部做完**。四處「寫好了點不到」都接上了入口，死碼也清掉了。
過程中審查擋下兩個實質缺陷：商品編輯清空售價會靜默把價格改成 0（`Number('')` 是 0 而
`Number.isInteger(0)` 為真），以及等級門檻的唯一索引撞號會丟一個店員看不懂的 500。
做 73 時順手把通知的收件人改成遮蔽值並拿掉 `variables`——營運要回答的是「送了沒、
為什麼失敗」，不需要顧客姓名與訂單細節。做 74 時把 `redact` 的簽章從 `(input)` 放寬成
`(input, output)`，否則稽核記不下「這次更正把什麼蓋掉了」。

**剩下的關卡不在程式碼裡**。58、59、60、61、62 的實機驗證要一座有公開網域的部署與
商家開通，那是釋出檢查，不是程式阻擋；66 已通過 Stage UAT，正式開通同樣是釋出設定。
**64 仍是 blocked**——它等的是商家實際開通的退款／查詢產品與它的契約，在拿到之前
不能由程式碼假設綠界那一側長什麼樣。所有外部服務能力一律先以 UAT／商家設定驗證。

**24（舊版訂單事件下線）於 2026-08-23 完成**。卡住它的一直是「外部部署有沒有人還在訂閱」，
而 2026-08-23 問出來的答案是**這套系統還沒有正式部署**——投遞是行程內的，沒有行程就沒有
訂閱者，那份清單因此是空的，問題不成立。過渡期每張訂單多發 3 筆 outbox 的代價隨之結束：
下單與付款現在各只發一筆。ADR 0017 同時失效（狀態改 superseded，全文保留）。


**這一批拍板的預設值**（2026-08-22）：限量券搶輸時整張單失敗（不是靜默不套用）；
購物金回饋 1%、付款後 7 天生效、發放後 365 天到期。理由記在對應的工單檔末段。

**09 → 13 → 15 → 23 → 24 是一組 expand–contract，2026-08-23 走完最後一步**。
訂單總額的語意變更會波及正在運作的 ERP 串接與後台，因此先加恆為零的欄位、
再讓新舊事件並行、接上定價引擎、下游遷移，最後才拆掉舊版。每一步 CI 都能綠。
其餘工單都是可獨立驗證的垂直切片。

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
| [50](50-strict-inputs.md) | 舊模組的輸入一律拒絕未知欄位 | — |
| [51](51-extension-input-bridge.md) | Extension 的輸入納入 strict，橋接明挑欄位 | 50 |
| [52](52-checkout-without-cart-id.md) | 結帳沒帶 cartId 時不要問到一台新的空車 | 28 |
| [53](53-bus-timing.md) | Command / Query Bus 記下執行時間 | — |
| [54](54-clawback-names-its-batch.md) | 取消訂單扣回購物金要指名批次 | 40, 42 |
| [55](55-bus-timing-slow-msg.md) | Bus 計時的整合測試會被機器忙碌搞紅，也會被搞綠 | 53 |
| [56](56-default-storefront-theme.md) | Default Theme 顧客前台 | 14, 20, 29, 38, 49 |
| [57](57-checkout-total-and-self-service.md) | 結帳總額透明與顧客自助付款操作 | 56 |
| [58](58-ecpay-release-validation.md) | ECPay 正式上線驗證與營運手冊 | — |
| [59](59-ecpay-logistics-adapter.md) | 綠界物流 Adapter：建單、標籤與追蹤號 | 58 |
| [60](60-convenience-store-picker.md) | 超商門市選店與目的地回填 | 59 |
| [61](61-admin-shipping-and-fulfillment.md) | 後台配送方式與出貨管理 | 59 |
| [62](62-shipment-tracking-and-order-notifications.md) | 物流追蹤與訂單生命週期通知 | 59, 61 |
| [63](63-refund-domain-and-operations.md) | 已付款訂單退款模型與後台作業 | 58 |
| [64](64-ecpay-refund-and-reconciliation.md) | ECPay 退款 Adapter 與付款對帳 | 58, 63 |
| [65](65-returns-and-exchanges.md) | 退貨與換貨案件（RMA） | 62, 63, 64 |
| [66](66-electronic-invoice-provider.md) | 台灣電子發票 Provider 與帳務流程 | 63 |
| [67](67-storefront-product-discovery.md) | 前台商品搜尋、篩選與分頁 | 56 |
| [68](68-admin-rma-workbench.md) | 後台退貨案件工作台 | 65 |
| [69](69-invoice-operations.md) | 電子發票的營運介面 | 66 |
| [70](70-invoice-issue-reconciliation.md) | 發票開立的對帳查詢：回應遺失時的補救 | 58, 69 |
| [71](71-admin-product-editing.md) | 後台商品編輯與上下架（**done**） | 02 |
| [72](72-loyalty-settings-operations.md) | 會員等級與購物金設定的營運介面（**done**） | 43, 45 |
| [73](73-notification-delivery-log.md) | 訂單與出貨通知的投遞紀錄（**done**） | 62 |
| [74](74-customer-birthday-correction.md) | 客服修正會員生日（**done**） | 22, 35 |
| [75](75-remove-legacy-markpaid.md) | 移除沒有呼叫端的 `commerce.order.markPaid`（**done**） | — |
| [76](76-content-module.md) | content 領域模組與接線（**done**） | — |
| [77](77-theme-contract-and-storefront-pages.md) | Theme 契約收斂與前台品牌頁面（**done**） | 76 |
| [78](78-admin-brand-content.md) | 後台品牌內容管理（**done**） | 76 |
| [79](79-contact-us.md) | 聯絡我們：前台表單與後台收件匣（**done**） | 76, 77 |
| [80](80-migrate-brand-content-to-seed.md) | 織日內容搬進 seed，`brand-content.ts` 下線（**done**） | 76, 77 |

**76–80 是 Spec 0007 的回填紀錄**（2026-08-26）：這一批不是先開工單再做，而是照
[Spec 0007](../specs/0007-brand-content-and-contact.md) 直接實作完再補上工單。
所以每張的驗收清單記的是**實際發生的事**，包含中途推翻的做法與 code review 擋下的缺陷，
而不是動工前的預期。設計理由在 ADR 0033、0034；這五張怎麼切，看 Spec 的交付順序。

## 已知、刻意沒做的

這一批做完之後仍然成立的取捨，寫在這裡免得下一個人以為是漏掉的：

### 讀取路徑上的三筆效能債

三筆都是「今天不痛」的取捨。量得到自己這件事由[工單 53](53-bus-timing.md) 補上了（每次 Command / Query 都寫一行
帶 `latencyMs` 的日誌，慢的升 `warn`），所以「先量」現在做得到——**但還沒有人真的量過**。
下一步是拿實際流量的數字回來，而不是直接動手改這三處：沒有數字就改，
只會把一個看不出效果的複雜度加進來。

**擋在部署上，不是擋在人上**（2026-08-23）：這個 repo 裡沒有可以量的流量，
數字要從實際跑起來的那座部署撈——`docs/operations.md` 的「要知道哪一支慢」寫了怎麼撈。
有了數字再回來看這張表，那時候要決定的才是「哪一筆真的值得動」。

| 在哪裡 | 現在做了什麼 | 屆時該做什麼 |
| --- | --- | --- |
| `cart/src/service.ts` 的 `toCartDto` | 每一行商品各查一次 catalog 與 inventory（2N 次往返）；會員還會整本讀購物金帳（`balanceFor` → `rewardEntriesFor`），因為餘額是 ledger 的推導值而不是欄位 | catalog／inventory 改批次查詢；餘額改讀一張定期結算的快照表 |
| `coupon/src/queries.ts` 的 `listMyCoupons`、`promotionPerformance` | 兩支都在迴圈裡逐列 `promotions.findById` | 一次撈齊該批活動，或在 repository 那層 join |
| `loyalty/src/repository.ts` 的 `outstandingRewards` | 依生效／到期分兩堆加總，**略低於真實負債**（過期批次的入帳被濾掉、對應的折抵卻還留著）；理由與量級寫在該函式的註解 | 要精確就得先有快照表——逐人跑 `deriveRewardBalance` 是 O(顧客數 × 帳本長度)，不能放在報表的同步路徑 |

**三者都不該用「把推導值改回欄位」來解**。餘額是 ledger 的推導值是 ADR 0019 的決定，
快取一份是可以的，換掉事實來源不是。今天的量級撐得住：購物金帳本每張訂單大約兩筆
（累積、折抵），券與活動都是後台維護的數量級。

### 其他

- **Extension Command 的 JSON body 不挑欄位**（工單 51 只挑 query string 那一側）。
  body 裡多出來的鍵一定是呼叫端自己送的，那正是該回 400 的情況；兩側不對稱是刻意的，
  理由記在 ADR 0024。
