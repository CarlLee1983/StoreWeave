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
| 前一版 DB＋jobs＋media 升級，並可重現 rollback；API／Worker mismatch 可檢出 | pending | B15 `cli-upgrade-paired.test.ts`、`release-transition.test.ts`、`full-restore.test.ts` 分別覆蓋 mechanics；B17 尚缺單一 DB＋job＋media drill |
| CI、Docker/native smoke、private media、real transport staging | pending | `make verify` 與 B15 local recovery 可重跑；Docker/native、SMTP、S3 staging 結果要附當次 artifact checksum |
| 下一個真實案子的共用／客製／工時／升級成本 | pending（產品驗證） | 等第一個實際專案後記錄；不可用技術測試估算 |

## 本輪 commands

```sh
pnpm typecheck
pnpm exec vitest run --project unit tests/architecture/b17-acceptance.test.ts packages/themes/base/test/base-theme.test.ts
pnpm exec vitest run --project integration tests/integration/b17-acceptance.test.ts
make verify
```

`make verify` 是完成定義；若 Testcontainers、Docker、SMTP 或 S3 環境缺失，結果記為 `not-run`，不改寫
程式碼來取得綠燈。
