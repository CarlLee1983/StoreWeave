# 91 — 釐清 ForgeFlowv2 整合責任與契約（discovery）

**GitHub:** [#28](https://github.com/CarlLee1983/StoreWeave/issues/28)

**What to build:** 收納使用者未來導入自研 ForgeFlowv2 的需求。取得可驗證來源後，再提出獨立整合 spec；這不是 adapter 或 runtime 實作票。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §6（獨立後續，不阻擋 81–90）

**Blocked by:** —

**前置資訊:** ForgeFlowv2 來源、版本與預期整合場景。此票不是 81–90 的前置。

**Status:** needs-information（尚缺 ForgeFlowv2 來源與預期場景）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

後續 ForgeFlowv2 discovery 文件與由證據產出的新規格草案；本票保持 StoreWeave runtime 零變更。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `docs/specs/0008-admin-foundations-and-contracts.md`
- `docs/architecture.md`
- `docs/extension-development.md`
- `docs/adr/0002-build-time-extension-assembly.md`
- `docs/adr/0007-shared-artifact-deployment.md`
- `packages/platform/extension-sdk/src/index.ts`

## Acceptance Criteria

- [ ] 先取得 ForgeFlowv2 repo／版本／可讀文件與至少一個使用者期望場景；拿不到就保持 needs-information，列出欠缺項，不猜它的產品類型。
- [ ] 以 source refs 記錄其責任、API／SDK／事件／UI 實際能力、執行與部署方式、認證、版本／license、錯誤、retry／idempotency 與資料所有權。
- [ ] 對照 StoreWeave 現有 Admin、HTTP、build-time Extension 接縫，說明哪些可直接沿用、哪些需新契約；若皆不適用，清楚記錄原因。
- [ ] 產出最小驗證案例、失敗／rollback 路徑、待決策事項與下一份 spec 的範圍；UI 不能直接承擔 backend workflow。
- [ ] 涉及公開 API、授權、資料或 Extension isolation 的方案由 Sol/high 分析並獨立審查；使用者確認整合範圍後，另拆實作票。
- [ ] 本票不新增 dependency、空 adapter、interface、endpoint、event、DB schema、設定或 demo runtime；81–90 可獨立完成。

## Verification

文件來源與版本可追溯、所有推論與待確認事項明列、相依／資料／安全／rollback 審查完成。文件票不製造程式測試；runtime diff 必須為零。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Out of Scope

任何 ForgeFlowv2 程式實作、替換 StoreWeave Jobs／Bus、在未看來源前指定 integration pattern。

## Rollback

純文件可回復；沒有 runtime 或資料變更。
