# 88 — 收斂商務編輯與操作頁的 Query 狀態

**GitHub:** [#25](https://github.com/CarlLee1983/StoreWeave/issues/25)

**What to build:** 將商品試點的 query／mutation 模式推廣到八個商務頁，讓更新後資料跨頁一致，同時保留各頁商務 payload、錯誤和冪等行為。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §3

**Blocked by:** [Ticket 81 / #18](https://github.com/CarlLee1983/StoreWeave/issues/18), [Ticket 84 / #21](https://github.com/CarlLee1983/StoreWeave/issues/21), [Ticket 85 / #22](https://github.com/CarlLee1983/StoreWeave/issues/22), [Ticket 87 / #24](https://github.com/CarlLee1983/StoreWeave/issues/24)

**Status:** done（2026-09-07；本機實作、主代理驗收與 Sol/high 整票終審 PASS；未 commit／push）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

PromotionsPage、CouponsPage、LoyaltyPage、BrandContentPage、OrdersPage、CustomersPage、RmaPage、ShippingPage 的 server state／tests；共用 query keys 與 api.ts 必要穩定 key 參數接線。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/api.ts`
- `apps/admin/src/pages/OrdersPage.tsx`
- `apps/admin/src/pages/CustomersPage.tsx`
- `apps/admin/src/pages/RmaPage.tsx`
- `apps/admin/src/pages/ShippingPage.tsx`
- `apps/admin/src/pages/PromotionsPage.tsx`
- `apps/admin/src/pages/CouponsPage.tsx`
- `apps/admin/src/pages/LoyaltyPage.tsx`
- `apps/admin/src/pages/BrandContentPage.tsx`

## Acceptance Criteria

- [x] 八頁伺服器資料改由 Query 提供，query keys 包含實際篩選／分頁／detail ID；form draft、展開列、dialog state 保留 local。
- [x] 寫入只由既有 api.* 送出；87 的 retry false、身分隔離與穩定操作 key 規範沿用，不以全域 invalidate 掩蓋依賴問題。
- [x] 建立各 command → 受影響 query 的最小對照，涵蓋 order detail／list、refund／RMA queues、會員資料／loyalty、商品庫存與 shipment；讓 89 可沿用相同 key。
- [x] 購物金調帳、等級積分、退款／重試、RMA 與出貨依 Spec §3 管理操作鍵：結果未知時重試沿用，結果已確定後明確發起新操作才換鍵（不以是否有表單判斷）；rerender／invalidate 不額外送出 command。測試覆蓋兩種 key lifecycle。
- [x] 搜尋連續變更、空結果、部分資料失敗、儲存成功、失敗保留表單與切換身分皆有代表性測試；清單不能把查詢失敗當成功空清單。
- [x] 既有 payload／null／cents／basis points／dates／PATCH 與狀態 guards 不變；移除這八頁重複的 server-state effect、loading/error state 與 reloadKey（只刪被 Query 接管者）。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；api.ts 有接線變更時加 pnpm typecheck／pnpm test。Sol/high 檢查財務操作與跨頁 invalidation；以安全本機資料操作 representative command。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Preparation（2026-09-07）

- `gh issue view 25 --repo CarlLee1983/StoreWeave --json title,body,state,url` 已核對遠端 OPEN，規格與本地本票一致；沒有 GitHub 寫入。
- 87 已完成：Admin 233 tests、root 561 unit tests、typechecks／build 與 Chromium 12/12，Sol/high 最終 Code／Standards／Spec PASS。沿用 Query 5.102.8、明確 retry false、memory-only identity boundary 與未確認操作的 immutable payload/key。
- 本票修改前快照：`/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-ticket88-baseline-lug7_lia`，含 Admin（排除 node_modules／dist）、root dependency/config、HEAD 與 git status；用以區分 81–87 既有 dirty diff，禁止在快照中安裝或共用可變 node_modules。
- 下一步依序：Sol/high 分析八頁 command→query 對照及財務操作生命週期；主代理確定最小共用邊界；Terra/high 逐一交付八頁並完成 source/browser 驗證；Sol/high 獨立審查與主代理最終驗收。Sol/high 分析已完成，主代理已確認下列實作邊界。

## Implementation plan（2026-09-07）

- [x] Sol/high 分析與主代理邊界決策：完整證據 `/tmp/storeweave-ticket88-sol-analysis.md`。沿用 87 的 generation／attempt 與 pending／unknown store，改名為 `admin-operations`；新增最小共用執行生命週期，各頁保留具體 api dispatcher 與 invalidation，不建立 resource provider。
- [x] **已完成：** Foundation 已完成 Sol PASS；Terra/high 兩個互斥頁面切片並行完成其餘八頁，逐頁跑行為測試。`admin88` 擁有 Orders／Customers／RMA／Shipping 與全部 shared API／query／i18n／ReasonDialog；`marketing88` 僅擁有 Promotions／Coupons／Loyalty／Brand Content 及各頁 tests。每個檔案只有一位 writer，primary 整合與 browser；仍只推進本票。
- [x] 主代理隔離 Chromium 驗證、完整必要 checks 與 baseline-aware diff 檢查。
- [x] Sol/high 獨立審查、修正與終審；主代理確認全部 AC 後更新交接。

操作 scope 以實體聚合避免未確認命令互相衝突；未知結果保留 immutable request／draft／key 與可離開篩選列查看的 preview，重試只讀 live entry。明確結果後下一次使用者操作才換 key。所有查詢接 signal，複合頁分開呈現讀取失敗與 Retry，不用空清單代替錯誤。

命令對照以分析報告的完整表格為準並由實作補入本票：付款依返回狀態區分 paid side effects；RMA 收貨僅含 restock 時刷新庫存；退款 requested 不提前刷新尚未發生的 invoice void；shipment shipped／arrived 才刷新通知。Order projection 未含 customerId，因此 pay／cancel 使用 customer detail／loyalty 的限定 prefix，不擴充 HTTP。89 的 invoice／notification／ERP／dead-job keys 僅建立已證實受 88 命令影響的 families。

## Command → query map（implemented）

| Domain command | Confirmed queries invalidated |
| --- | --- |
| Promotion / coupon create, update, status, issue | Its own list family only |
| Reward settings | reward settings only |
| Tier save or remove | tiers only |
| Article create, update, publish, unpublish, delete | article lists |
| Customer status / birthday | customer lists and that customer detail |
| Reward adjustment | that customer loyalty and outstanding rewards |
| Tier-point adjustment | that customer loyalty only |
| Pay | order lists, exact `orderKeys.detail(orderId)`, bounded customer details; only returned `paid` also inventory, loyalty customers, outstanding rewards, invoices, lifecycle deliveries and ERP deliveries |
| Cancel | order lists, exact `orderKeys.detail(orderId)`, bounded customer details, inventory, coupons, loyalty customers and outstanding rewards |
| Request full refund | refund lists only |
| Retry refund | refund lists and RMA lists |
| RMA approve / information / reject | RMA lists only |
| RMA receive | RMA lists; inventory lists only when a saved line is restocked |
| RMA request / retry refund | RMA lists and refund lists |
| Shipping method create / update | shipping-method lists |
| Create shipment | exact returned shipment detail; when its returned provider is ECPay, shipment-operation list/detail; successful recovery also restores the returned shipment inspector locally |
| Advance shipment | exact shipment detail; lifecycle deliveries only for shipped / arrived |
| Retry ECPay shipment | shipment-operation lists/detail, exact shipment detail and dead-job lists |

No command uses a global invalidate. Unknown commands retain their saved request/draft/key in the domain operation entry; the recovery surface is outside list filters and expanded rows.

## Out of Scope

後端狀態機、授權、資料表、query API 擴充，UI 再設計、通用 CRUD provider。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。


## Final acceptance（2026-09-07）

- 八頁全部 AC 已由主代理確認；Terra/high 實作，Sol/high 整票 Standards／Spec PASS、零剩餘發現。完整終審 `/tmp/storeweave88-final-review.txt`；76 source/test/config hashes `/tmp/storeweave88-reviewed-source-final.json`，終審及最終測試後一致。
- 最終 Admin 26 files／286 tests、Admin typecheck／build、root 48 files／561 tests／typecheck、`git diff --check` 全 PASS。logs `/tmp/storeweave88-admin-test-round4.log`、`/tmp/storeweave88-admin-{typecheck,build}-round3.log`、`/tmp/storeweave88-root-{typecheck,test}-round2.log`。最後 round4 僅三個測試檔變動，runtime 與已驗證 round3 一致。Build 保留既有 chunk-size warning。
- 主代理隔離 Chromium：20 command／13 marketing／9 read-layout 完整 batch PASS；另加退款成功後 held-refetch gate 與兩個 repeated-unknown reason-dialog cases 均 PASS。涵蓋 applied-response-lost、不重複金錢／庫存、相同 key/payload recovery、終局拒絕及新 key、raw draft、modal focus、部分讀取失敗、搜尋取消、身分切換、三語×雙主題×360/1280、局部 table scroll。Scripts/results/screenshots `/tmp/storeweave88-primary-browser`；full-commands-round2.log、marketing-round2.log、full-read-layout-round2.log 及 refund-refetch-gate.log／orders-reason-dialog.log／rma-reason-dialog.log。
- 87 商品與 foundation recovery 回歸亦 PASS：`foundation87-fixed` 12/12、`foundation87-identity` confirmed-refetch identity-clear；共用 executor regression 由 Sol 獨立確認因果性。
- 主要變更：八頁及各頁 tests；`api.ts`／`query.ts` 與 tests；`admin-operations.tsx`、四 concrete commerce operation helpers／map tests；ReasonDialog／ErrorBanner、i18n 與必要 styles。原 product operation store 已由共用 store 取代。沒有新增依賴、DB migration、後端或授權邊界變更；root manifests／lock/config 與本票 baseline 一致。
- API signal 18 reads、32 distinct command keys、所有 semantic query inputs／identities、完整 conditional invalidation map 均有持久測試；退款／調帳終態拒絕與未知重試、雙向 aggregate occupancy、不同 shipment operation kind、held-refetch 與 enabled-focus 均有 regression。
- Integration／Docker smoke 的既有 baseline 失敗仍依 Ticket 86 證據留給 Ticket 90；本票沒有重新宣稱全庫整合／外部 merchant UAT 通過。外部64／70 UAT與91來源缺口維持原紀錄。
