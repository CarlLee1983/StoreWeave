# B17 acceptance matrix

這份表把 Spec 0009 §8 的結果與可重跑證據分開。Base 工程結論為 `pass`：implementation、呼叫端、
文件與 repository gates 已落地，且本機 SMTP 設定已完成實測。`pending` 的 quality／coverage、release gate
與產品驗證保留原樣追蹤，不改變 Base 工程完成狀態，也不構成 production-ready 聲明。

| Spec 0009 §8 項目 | 狀態 | 證據／下一步 |
| --- | --- | --- |
| F01–F16 每項有 implementation、文件、故障測試、範例 | pass（Base 工程） | [逐項 owner audit](f01-f16-owner-audit.md) 已定位 B01–B16 implementation/docs/failure tests/callers，補回 B10 文件並修正 Extension recurring schedule 斷線。`commerce-public-contract.structural.v1.json` 固定 87 Commands／62 Queries／19 Events／14 Jobs（含 schedule）與 7 個 Extensions，checksum 引用 202-route HTTP golden。semantic v2 ledger 對 composed Commerce registry／HTTP catalog 的 586 個 surfaces 重算 703 個 category-specific runtime facets；145 個 executable cases 明確覆蓋 core、ECPay config、MCP 與 107 個 bus/composed HTTP input mappings，其餘 560 個 facet 精確留在 `remaining`。provenance hash 不算語意覆蓋；SDK exports、runtime config keys、CLI commands 與完整 semantic coverage 在此 ledger 範圍外。owner audit 與完整 repository gates 支持工程完成；這份可列舉的 coverage 限制保留為品質工作，不宣稱 exhaustive semantic coverage。 |
| 同一 base 版本組出購物站、形象站、Blog；非電商不載入 Commerce | pass（技術切片） | `tests/architecture/b17-acceptance.test.ts`；`tests/integration/b17-acceptance.test.ts` 的 shopping、image-site、Blog profiles；`tests/integration/release-artifacts.test.ts` 的同版 build |
| 兩個 Theme 切換後內容、媒體、URL、導覽、功能設定保留 | pass（Base） | `tests/integration/b17-acceptance.test.ts` 驗證 Base → Editorial；架構測試也驗證三個 release 的每個 Theme 覆蓋自身頁面圖；兩個 option namespace 逐一比較 |
| 非電商模組 upload → job → status → notification，含重啟與拒絕 | pass（前置包） | B16 `tests/integration/file-requests-example.test.ts` 與 [B16 README](../b16/README.md)；B17 不重複搬移模組 |
| 新模組只改 module／site assembly，契約錯誤可檢出 | pass（前置包） | B16 module contract tests；`tests/architecture/module-example-boundaries.test.ts`、`module-graph.test.ts` |
| Commerce flow、data、event、integration、Admin 回歸 | pass（CI matrix） | 現有 Commerce suite 已通過各包 gate；`b00-catalog.json` 已分開固定 B00 baseline 與完整 current registry。完整 release matrix 已於 main 的 [`685b732` run](https://github.com/CarlLee1983/StoreWeave/actions/runs/34685750936)（2026-09-12）全綠：10 個 job 涵蓋 typecheck+unit、admin、integration shard 1/2 與 2/2、完整 integration、Docker base/commerce smoke 與 native base/commerce smoke，並上傳四份綁 revision 的 evidence artifact（digest 見下一列）。此後 HEAD 推進到 `21a77b9`，diff 僅 `CONTEXT.md` 與 `docs/adr/0051-*.md`，為 docs-only，不影響本列證據 |
| 前一版 DB＋jobs＋media 升級，並可重現 rollback；API／Worker mismatch 可檢出 | pass（技術演練） | `tests/integration/full-restore.test.ts` 以目前編譯的 Commerce release 為 N、patch 版 probe migration 為 N+1；同一流程驗證 site data、來源 pending job 在新版 Worker 可執行、原始／preview 私有媒體 SHA，以及 full bundle 回復同一 job identity／payload version／run time 並重建兩份媒體 bytes；quarantine 仍保存 N+1 history、completed job 與 probe data。`tests/integration/release-artifacts.test.ts` 另以兩份 build artifact 直接證明 API、Worker 與 operational CLI 在未啟用的跨版本 history 上拒絕啟動。這個 stopped-writer deterministic drill 不代替下一個已發布 binary 的實際升級證據，也不偵測違反流程而持續執行的舊 Worker。 |
| CI、Docker/native release smoke | pass | main 的 [`685b732` run](https://github.com/CarlLee1983/StoreWeave/actions/runs/34685750936)（2026-09-12）10 個 job 全綠，並上傳四份 artifact：`docker-smoke-base` `sha256:2df7c43aacd305f7cf03e9cee00128b49a9ed41f3922c95caa7b0807625aac63`、`docker-smoke-commerce` `sha256:5c507ae46ea445c76371691ba7cfc98997abbc4807b614c447620c53256cd273`、`native-smoke-base` `sha256:2e641ba3ad1fb916e5af26bc2344807fe068b23990efa2efecaa9f4451a0e78c`、`native-smoke-commerce` `sha256:304ab6d718416625248d58b36e488a36f3d1abcaeb518e799a3cd250faae62f1`，內容依 `.github/workflows/ci.yml:121,168` 含 evidence、build-info、release-manifest，native 另含 tarball。 |
| private media、真實 transport staging | pending（release gate） | 本機 SMTP 設定已完成實測；這不代表 staging／production 設定已完成。private-media 與真 S3 staging 仍待特定部署環境，限制相應的 release 主張，不阻擋 Base 工程完成。 |
| 下一個真實案子的共用／客製／工時／升級成本 | pending（產品驗證，不阻擋 Base） | 等第一個實際專案後記錄；不可用技術測試估算。 |

## 本輪 commands

```sh
pnpm typecheck
pnpm exec tsx scripts/b17-public-contract.ts --check
pnpm exec tsx scripts/b17-public-contract-semantic.ts --check
pnpm exec vitest run --project unit tests/architecture/b17-public-contract.test.ts tests/architecture/b17-public-contract-semantic.test.ts tests/unit/smoke-evidence.test.ts
pnpm exec vitest run --project integration tests/integration/http-catalog-artifact.test.ts tests/integration/runtime-lifecycle.test.ts tests/integration/ecpay-logistics.test.ts
pnpm exec vitest run --project unit tests/architecture/b17-acceptance.test.ts packages/themes/base/test/base-theme.test.ts
pnpm exec vitest run --project integration tests/integration/b17-acceptance.test.ts
pnpm exec vitest run --project integration tests/integration/full-restore.test.ts
make verify
```

`make verify` 是完成定義；若 Testcontainers、Docker、SMTP 或 S3 環境缺失，結果記為 `not-run`，不改寫
程式碼來取得綠燈。
