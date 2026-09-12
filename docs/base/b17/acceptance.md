# B17 acceptance matrix

這份表把 Spec 0009 §8 的結果與可重跑證據分開。`pass` 只代表列出的技術證據已通過；`pending` 代表
尚未有足夠證據，不能因為相鄰的 unit／integration 測試通過就代填。

| Spec 0009 §8 項目 | 狀態 | 證據／下一步 |
| --- | --- | --- |
| F01–F16 每項有 implementation、文件、故障測試、範例 | pending | B01–B16 各包 README 與測試；B17 的 baseline/current catalog 已固定，仍需逐項 owner review |
| 同一 base 版本組出購物站、形象站、Blog；非電商不載入 Commerce | pass（技術切片） | `tests/architecture/b17-acceptance.test.ts`；`tests/integration/b17-acceptance.test.ts` 的 shopping、image-site、Blog profiles；`tests/integration/release-artifacts.test.ts` 的同版 build |
| 兩個 Theme 切換後內容、媒體、URL、導覽、功能設定保留 | pass（Base） | `tests/integration/b17-acceptance.test.ts` 驗證 Base → Editorial；架構測試也驗證三個 release 的每個 Theme 覆蓋自身頁面圖；兩個 option namespace 逐一比較 |
| 非電商模組 upload → job → status → notification，含重啟與拒絕 | pass（前置包） | B16 `tests/integration/file-requests-example.test.ts` 與 [B16 README](../b16/README.md)；B17 不重複搬移模組 |
| 新模組只改 module／site assembly，契約錯誤可檢出 | pass（前置包） | B16 module contract tests；`tests/architecture/module-example-boundaries.test.ts`、`module-graph.test.ts` |
| Commerce flow、data、event、integration、Admin 回歸 | pending | 現有 Commerce suite 已通過各包 gate；`b00-catalog.json` 已分開固定 B00 baseline 與完整 current registry，仍需在 CI 跑完整 release matrix 後才能勾選 |
| 前一版 DB＋jobs＋media 升級，並可重現 rollback；API／Worker mismatch 可檢出 | pass（技術演練） | `tests/integration/full-restore.test.ts` 以目前編譯的 Commerce release 為 N、patch 版 probe migration 為 N+1；同一流程驗證 site data、來源 pending job 在新版 Worker 可執行、原始／preview 私有媒體 SHA，以及 full bundle 回復同一 job identity／payload version／run time 並重建兩份媒體 bytes；quarantine 仍保存 N+1 history、completed job 與 probe data。`tests/integration/release-artifacts.test.ts` 另以兩份 build artifact 直接證明 API、Worker 與 operational CLI 在未啟用的跨版本 history 上拒絕啟動。這個 stopped-writer deterministic drill 不代替下一個已發布 binary 的實際升級證據，也不偵測違反流程而持續執行的舊 Worker。 |
| CI、Docker/native smoke、private media、real transport staging | pending | PR #45 的 [CI run](https://github.com/CarlLee1983/StoreWeave/actions/runs/34675547015) 在 `6d062f9` 通過 typecheck、unit、admin、完整 integration、Commerce Docker 與 native smoke；該 run 沒有上傳 artifact，也未記錄 release-manifest checksum，因此仍需 checksum-bound 的雙 release smoke、private-media staging、SMTP 與 S3 staging 證據。 |
| 下一個真實案子的共用／客製／工時／升級成本 | pending（產品驗證） | 等第一個實際專案後記錄；不可用技術測試估算 |

## 本輪 commands

```sh
pnpm typecheck
pnpm exec vitest run --project unit tests/architecture/b17-acceptance.test.ts packages/themes/base/test/base-theme.test.ts
pnpm exec vitest run --project integration tests/integration/b17-acceptance.test.ts
pnpm exec vitest run --project integration tests/integration/full-restore.test.ts
make verify
```

`make verify` 是完成定義；若 Testcontainers、Docker、SMTP 或 S3 環境缺失，結果記為 `not-run`，不改寫
程式碼來取得綠燈。
