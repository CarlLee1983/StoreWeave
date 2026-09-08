# B01 — 模組公開契約

狀態：done，2026-09-07。前置 [B00 已完成](../b00/README.md)；本包依 [B01 派工卡](../b00/next-work-cards.md#b01--先交付可驗證模組圖) 與 [Spec 0009](../../specs/0009-complete-modular-base.md) 執行。

## 目標與範圍

為現有 commerce 與非商務活動報名 consumer 提供可驗證的模組 id／版本／base range、required／optional dependencies、能力與資料／migration ownership。缺相依、cycle、重名、版本不相容、非法受控資源存取須在清楚的 Interface 被拒絕；保留現有公開識別、payload、subscriber 名稱及 migration id／SQL。

沿用明確 constructor injection；領域模組不依賴 Nest／React 或全域 service locator。trusted Node module 並非惡意程式 sandbox；受限 Extension SDK 不增加 raw DB／其他模組 repository。B02 才交付完整 release/config/migration 選取與生命周期；B04 才修改 Queue 可靠性。

## 執行順序

| 步驟 | 狀態 | Owner／出口 |
| --- | --- | --- |
| 1. 對齊現況與契約 | done（Sol 設計已採納；細節追問不阻擋純圖驗證） | Sol/high 唯讀契約與安全分析；Terra/high 唯讀直接相依／公開操作／資料 ownership 盤點；主代理定最小介面與行為測試 |
| 2. 可運作的模組圖與兩個 consumer | done | 主代理單獨實作 metadata／validation／registration 與實際 consumer，無空接口交付 |
| 3. 驗證與文件 | done | focused graph／真 PG transaction 與 capability 拒絕測試、相關既有回歸、typecheck／root tests；記錄相容與回復 |
| 4. 獨立審查與結案 | done | 未參與實作的 Sol/high 雙軸審查；所有 findings 收斂才解鎖 B02 |

共同接線、metadata／migration ownership、跨模組及授權變更均由主代理持有。子代理目前不寫 production code；新增依賴前先檢查現有 semver／authorization／contracts。

## 基準與驗證狀態

- HEAD `1f4470d810a84fc43d97c1990c32c5e71608dd7f`；保留 81–90 與 B00 未提交成果。
- B01 起始 727 檔快照由 `/tmp/storeweave-base-b01-baseline-path` 指向；全檔 hash `/tmp/storeweave-b00-complete-worktree-hashes.json`。不把隔離 PoC 的 node_modules 複製成 production 依賴。
- [B00 公開介面盤點](../b00/compatibility-inventory.md) 是現有識別的基準，不重做 Queue 研究或後台驗收。
- 主代理已實作 graph preflight、全體 declarations、tagged constructor binding、scoped subscriber command 與四個 repository 邊界；已完成本包驗證與獨立審查，B01 done；B02–B17 仍未完成。

### 已取得的現況證據

- 唯讀相依／ownership 盤點已完成，原始結論 `/tmp/storeweave-b01-dependency-inventory.txt`；現有 commerce runtime-import graph 沒有 SCC，constructor 注入的同步操作與 Outbox subscriber links 必須另行辨識／驗證，不能省略其可用性要求或混成初始化順序。
- `identityModule.name` 是 `platform-identity`，歷史 `MigrationSet.module` 是 `identity`；兩者皆保留。Kernel 的 `platform` migration set 另擁有共用表，`platform_migrations` 是 migrator metadata。
- 起始 baseline 的 `PlatformModule` 尚無 version 欄位；B01 已加入且直接取各 package.json。現有 Content／RMA package 為 `0.0.0`，其餘 commerce 與 kernel／identity 為 `0.1.0`；保留個別版本，不做統一升版。`PLATFORM_VERSION` ABI 仍為 `1.0.0`，與 package 版本分開，Extension 相容規則不變。
- 起始盤點找到公開 barrel 匯出且被跨模組使用的 `CartRepository`／`CouponRepository`／`PromotionRepository`；已依下述 owner 操作介面收斂，不以 metadata-only 宣稱已阻擋任意 Node／SQL。

## 已採納的 Interface

詳見 [ADR 0036](../../adr/0036-validate-module-composition-before-runtime.md)。`name` 保留既有識別；`version` 直接取 package.json；`baseVersionRange` 驗證 Base ABI。`dependencies.required/optional` 是有排序意義的靜態相依；`capabilities.required/optional/bound` 是明確 constructor 操作 binding。只有前者拒絕 cycle，後者仍完整驗證 provider／版本／宣告與實際參數。optional provider 缺席且未 binding 合法；provider 存在卻漏接、provider 不在卻留下 binding，皆拒絕。

`createRuntime` 的 in-memory `platform` 節點擁有原共用 migration、資料表及內部投遞 job；全體正式模組宣告 platform 相依。圖通過才建立 Database，圖的固定順序也用於 registration。subscriber 的外部 command 必須列在該 subscriber 的 `commands`，精確匹配 owner／name／descriptor version；預檢還要求對 owner 有靜態相依或已驗證 binding。未宣告的執行在觸及 executor 前回 `FORBIDDEN`。

四個 repository 缺口已收斂：Cart 提供 checkout facts／items／封存與 owner 限制的 pickup lookup；Coupon 自行鎖定、驗券與保存核銷；Promotion 提供券所需的有效期間、說明及自動發券投影。既有結帳先 cart lock、再 coupon lock 的順序保留，核銷仍在同一交易內。Customer 對 Identity 的 UserRepository 存取也改走 accountService.contactFor 的 email 投影。受影響的 private package repository／schema barrel exports 移除；B00 的 89 個 Extension SDK exports 不變。

## 驗證與結案紀錄

- `pnpm typecheck`：PASS（含非商務 consumer）。
- `pnpm exec vitest run --project integration tests/integration/module-consumers.test.ts`：4 PASS，真 PostgreSQL 上非商務 migration／command／query、容量拒絕時 row＋Outbox rollback、權限與 scoped command 拒絕。
- 結帳、限量券、券回沖、退款競態、RMA、發票與通知的 focused integration：7 files／38 PASS。
- 16 個既有 migration source 與 B01 baseline byte-for-byte 相同；root package.json／pnpm-lock.yaml 不變，沒有新增依賴。
- `pnpm test`：49 files／572 PASS；最新 log `/tmp/storeweave-b01-unit-final.log`。
- `pnpm test:integration`：59 files／509 PASS；log `/tmp/storeweave-b01-integration.log`。測試容器已清理，原六個 dbcli 容器未動。
- 使用與 `scripts/build.mjs` 相同 Node22／CJS／external 設定，API／worker／CLI 打包 PASS；隔離 artifact 由 `/tmp/storeweave-b01-build-path` 指向，CLI `--version` 回 `0.1.0`，未覆寫既有 release。
- 補強後純 graph：11 PASS，log `/tmp/storeweave-b01-graph.log`；遞迴掃描 commerce src，包含 Identity repository 邊界。最終 `pnpm typecheck` PASS，log `/tmp/storeweave-b01-typecheck.log`。
- 最後 Identity email 投影變更後，Identity／Customer／checkout／signup coupon／lifecycle notification：5 files／43 PASS，log `/tmp/storeweave-b01-identity-regression.log`。
- 獨立 Sol/high Standards：PASS，零剩餘 findings；第一輪唯一 Low 文件盤點時態已修正。Security／correctness PASS。紀錄 `/tmp/storeweave-b01-standards-final.txt`。
- 獨立 Sol/high Spec：PASS，零 findings；同一文件修正複核後維持 PASS。紀錄 `/tmp/storeweave-b01-spec-final.txt`。
- 42 檔送審版本固定於 `/tmp/storeweave-b01-reviewed-final.json`；完整 diff `/tmp/storeweave-b01-review-diff.txt`。此後僅結案／下一包狀態更新，production 未變。
- 140 個可直接解析的 Command／Query／Event 宣告與 baseline 完全相同；48 個送審文件本機連結通過；既有 release 2,461 檔 hash 無變。
- B01 已解鎖 [B02 派工卡](../b00/next-work-cards.md#b02--同一份-release-選取模組設定與資料)。B02 先做 Sol 風險分析與明確 release／migration 契約，不擴大 B01 成完整 Base 完成聲明。
