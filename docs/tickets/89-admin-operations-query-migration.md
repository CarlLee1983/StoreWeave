# 89 — 收斂營運查詢、重送與外殼徽章的 Query 狀態

**GitHub:** [#26](https://github.com/CarlLee1983/StoreWeave/issues/26)

**What to build:** 把剩餘七個營運頁與 App 的 DLQ count 接到共用 Query；確保人工重送與跨頁摘要更新都沿用同一份 server state。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §3

**Blocked by:** [Ticket 86 / #23](https://github.com/CarlLee1983/StoreWeave/issues/23), [Ticket 88 / #25](https://github.com/CarlLee1983/StoreWeave/issues/25)

**Status:** done（2026-09-07；本機驗收完成，Sol/high Standards／Spec PASS；未提交或遠端寫入）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

AnalyticsPage、DlqPage、ErpPage、InvoicesPage、NotificationsPage、SystemPage、ContactInboxPage、App 的 DLQ count、其 tests／共用 keys；必要 api.ts operation-key 接線。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/App.tsx`
- `apps/admin/src/pages/AnalyticsPage.tsx`
- `apps/admin/src/pages/DlqPage.tsx`
- `apps/admin/src/pages/ErpPage.tsx`
- `apps/admin/src/pages/InvoicesPage.tsx`
- `apps/admin/src/pages/NotificationsPage.tsx`
- `apps/admin/src/pages/SystemPage.tsx`
- `apps/admin/src/pages/ContactInboxPage.tsx`
- `apps/admin/src/api.ts`

## Acceptance Criteria

- [x] 七頁所有 server-state 查詢含 ERP payload detail 均使用 Query；日期／狀態／訂單 ID／detail ID 進入 key，App DLQ badge 和頁面數量按同一失效規則更新。
- [x] ERP、DLQ、invoice issue／void 重試和 contact handled 維持既有可執行條件；query retry false、mutation retry false。依 Spec §3，timeout／斷線的結果未知重送沿用原 key，前次結果明確後使用者發起的新合法操作換新 key，即使 payload 相同；兩種行為皆有測試，避免永遠 replay 舊結果而無法再次重送。
- [x] 更新後使受影響的作業清單、DLQ badge、相關發票／訂單或分析 query 失效；相同實際查詢沿用 88 的 key，不新增另一份 registry。
- [x] health 的 raw response 與失敗 envelope 仍由 api.ts 處理；部分來源失敗有可觀察結果，不把 session 失效當正常健康或零筆資料。
- [x] 舊身分 pending requests、快速切頁、重送失敗及成功更新有回歸測試；角色／token 改變時無前一身分資料。
- [x] 完成後所有業務資料頁沒有同份 server state 的 effect／reloadKey 平行路徑；auth bootstrap 可以保留清楚的獨立責任，不為統一而重做登入協定。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；api.ts 有變更加 pnpm typecheck／pnpm test。Sol/high 審查發票／ERP 重送與跨頁 cache；本機 DLQ badge→作業頁流程驗證。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Out of Scope

新的 polling／realtime、provider 或背景佇列替換、client audit log、持久化快取、直接打外部服務。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。


## Preparation（2026-09-07）

- authenticated `gh issue view 26` 已核對遠端 OPEN 與本地規格一致；沒有遠端寫入。
- 88 已完成：Admin286／root561、typechecks／build／diff、隔離 Chromium command/read/layout/recovery、Sol/high 整票 PASS。76 final hashes `/tmp/storeweave88-reviewed-source-final.json`；其 Vite 與三個 owned panes 已清理。
- 修改前 baseline `/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-ticket89-baseline-6ayo2yue`，pointer `/tmp/storeweave-ticket89-baseline-path`；禁止在 baseline 安裝或共享可變 node_modules。
- [x] Sol/high read-only 分析完成，完整 `/tmp/storeweave-ticket89-sol-analysis.txt`；主代理接受 immediate scheduling 與 later worker effects 的區分。分析pane已關閉。
- [x] **已完成：** 主代理邊界與單writer ownership已確認；`reads89`／`wA:p16` Terra/high 接 shared API/query/App＋Analytics/Notifications/System，shared介面已穩定，`commands89`／`wA:p17` Terra/high另接四個 command pages／tests，單檔單writer。任務 `/tmp/storeweave-ticket89-implementation-assignment.md`。
- [x] 主代理 checks／隔離 browser；Sol/high 獨立審查與最終驗收。

## Implemented command → query map（終審通過）

| Confirmed command | Invalidated query families |
| --- | --- |
| ERP resend | ERP delivery lists、dead-job lists、health dependencies；payload detail 不變 |
| DLQ retry | dead-job lists、health dependencies；不以 job type 推定背景工作已完成 |
| Invoice issue retry | invoice lists／exact detail、dead-job lists、health；invoice read 是針對 racing worker 的 best effort，不表示已開立 |
| Invoice void retry | invoice lists／exact detail、dead-job lists、health；保留回傳 void_pending |
| Contact handled | contact-message lists |
| Existing pay（任何回傳狀態） | 保留88 effects，另加 sales-summary family |
| Existing cancel | 保留88 effects，另加 sales／promotion-performance／partner-performance families |
| Existing promotion update | promotion lists＋promotion-performance family，因報表讀取目前活動名稱 |

App badge 與 DLQ page 共用 `deadJobKeys.lists` 失效規則；相同 API 不建立第二組 keys。初始 badge 讀取失敗顯示可存取的 `!`，普通 refetch 保留最後成功的 count。Health 的 raw 200／degraded 與錯誤 envelope 仍由 api.ts 解讀，health／extensions 分開呈現。

## 初次候選驗證（下方 Final acceptance 為最終結果）

- Primary Admin typecheck／26 files 293 tests／build、root typecheck／48 files 561 tests、diff check PASS。`/tmp/storeweave89-admin-{typecheck,test,build}.log`、`/tmp/storeweave89-root-{typecheck,test}.log`。
- 隔離 Chromium 8 read／13 command 全批次 PASS；84 組七頁×三語×雙主題×360/1280 layout PASS，主代理目視 JA360 Analytics／ERP。含 ERP active drawer repeated-unknown→terminal rejection、DLQ badge同步、DLQ/contact held-refetch、old identity page/badge cancellation。
- Evidence `/tmp/storeweave89-primary-browser/{reads-final.log,commands-final.log,layout.log}`、對應 `.mjs`／JSON／screenshots。fixture所有 API／health request均攔截，無merchant/provider寫入。
- 76 source/test/config frozen hashes `/tmp/storeweave89-source-candidate.json`、45 runtime hashes `/tmp/storeweave89-runtime-review-candidate.json` 均已核對一致。
- `reads89`／`commands89` Terra/high slices frozen；`review89` Sol/high 正在做整票 Standards／Spec source及regression-causality審查。綠色測試不代替終審，取得結論並處理發現前不標記完成。

## Final acceptance（2026-09-07）

- Sol/high 整票 Standards／Spec **PASS，零剩餘發現**。兩輪 findings 僅為測試證據，已補因果性的五命令 duplicate suppression、invoice issue／void 失效與 scope、ERP row／drawer 共用操作、獨立讀取失敗及既有欄位狀態斷言。終審 `/tmp/storeweave89-final-review.txt`。
- 最終 Admin **26 files／307 tests PASS**（`/tmp/storeweave89-admin-test-round3.log`）；Admin typecheck／build、root typecheck／48 files 561 tests、diff check PASS。最後兩轮只改 tests，runtime 未變，原 build／root／browser 證據仍有效。既有 build chunk-size warning 保留。
- Chromium 全批次 **8 read／13 command／84 layout PASS**；三語、雙主題、360／1280、ERP drawer 焦點與同鍵恢復、身分取消、DLQ badge 與 confirmed-refetch gate 均已覆蓋。API／health 全為隔離 fixture。
- 主代理核對最終76個 source/test/config hashes：`/tmp/storeweave89-reviewed-source-final.json`。變更邊界為七營運頁與 tests、shared API/query/App/routes/i18n/styles，以及既有 order／promotion commands 的 analytics invalidation。沒有新依賴、DB migration、HTTP shape 或角色權限變更。
- Integration／Docker／native smoke 的全庫 closure 由 Ticket90 處理；先前已證實的 baseline 失敗見 handoff，不宣稱全庫 CI 已綠。無 commit／push／GitHub 寫入／部署。
