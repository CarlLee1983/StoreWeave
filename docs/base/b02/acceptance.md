# B02 驗收對照

2026-09-08。Standards／Spec 與最後產物驗證已通過，B02 結案。
範圍依 [B02 派工卡](../b00/next-work-cards.md#b02--同一份-release-選取模組設定與資料)，不取代完整 B03–B17。

| 要求 | 實作與可重跑證據 | 結果 |
| --- | --- | --- |
| 同一 release 選取 API／worker／CLI／seed／build | `bundle/src/releases`、`bootstrap-release.ts`、`scripts/build.mjs`；`release-artifacts.test.ts` 檢查四個 emitted graphs 與 manifest | 通過 |
| Base 不依賴 Commerce 程式／設定／角色／資產 | `base-release.test.ts`、`release-config.test.ts`、`release-artifacts.test.ts`；Base 原生／Docker 10 項煙霧檢查 | 通過 |
| Commerce 公開行為相容 | 完整 integration；Commerce 原生 61 項、Docker 62 項檢查；`release-roles.test.ts` 保留顧客政策 | 通過 |
| 必要 seed 與 demo 分開且可重跑 | 預設 seed 不造商品／帳號，Base 拒絕 demo；Commerce demo 全部資料集、強制失敗退出、兩次完整狀態比較 | 通過 |
| owner／checksum／順序與未知歷史拒絕 | `migration-history.test.ts`、`migration-lock.test.ts`；固定 SQL prefix、單 connection 鎖、影子函式與並行遷移 | 通過 |
| 停用保留 metadata／資料，重啟驗證 | `release-transition.test.ts` 覆蓋 disabled history、重新啟用、retained tables／sequences、ABI、錯誤 pins | 通過 |
| 有相依／未完成工作不可移除，不自動 DROP | module graph 與 `release-transition.test.ts` 覆蓋 direct／subscriber jobs、outbox pending／running／dead、未知工作 | 通過 |
| 初始化失敗逆序清理，shutdown 有限時 drain | `runtime-lifecycle.test.ts`、`worker-recovery.test.ts`、`cli-service-stop.test.ts`；真子程序、中斷、timeout、既有服務保留 | 通過 |
| 保存來源程式／DB 與中斷重跑 | `cli-upgrade-paired.test.ts`、`release-snapshot.test.ts`、`database-cutover.test.ts`；部分 SQL、候選綁定、journal 與 OID 恢復 | 通過 |
| B01 採納與舊版還原 | `cli-legacy-upgrade.test.ts` 使用保留 B01 CLI/API；raw／paired、採納前屬性漂移拒絕、current 前後與 DB commit 後 SIGKILL、journal resume | 通過 |
| Native／Docker／Debian 邊界 | installer 與 CLI 共用 flock；`native-install-guard.test.ts`、`deb-media.test.ts` 與實際 tarball → deb → install → purge | 通過 |
| 操作文件／決策／獨立審查 | [原生部署](../../deployment-native.md)、[ADR 0037](../../adr/0037-release-selection-and-history.md)；全新 Sol/high 分別完成 Standards 與 Spec，所有 findings 已修正並複查 | 通過 |

上述測試位於 `tests/integration/`，`release-config.test.ts` 與 `cli-service-stop.test.ts` 位於 `tests/unit/`。
主要程式目錄位於 `packages/platform/`；CLI 位於 `tools/cli/src/`。

## 執行證據

- 完整 integration：77 files／598 tests，`/tmp/storeweave-b02-audit-final-integration.log`。使用 `STOREWEAVE_B01_CLI_FIXTURE` 指向保留的 B01 `cli.js`，因此包含真舊 CLI/API。
- 完整 unit：57 files／721 tests，`/tmp/storeweave-b02-audit-final-unit.log`。最後 systemd 狀態判斷修正另有 11 項聚焦回歸與 typecheck：`/tmp/storeweave-b02-systemd-state.log`、`/tmp/storeweave-b02-systemd-state-typecheck.log`。
- Admin：26 files／314 tests 與 typecheck，`/tmp/storeweave-b02-final-admin.log`、`/tmp/storeweave-b02-final-admin-typecheck.log`；之後未改 Admin。
- Base 最新原生：`/tmp/storeweave-b02-closed-native-base.log`，0.2.0-test66，10/10；archive 內 CLI 含最後 systemd guard。
- Commerce 最新原生：`/tmp/storeweave-b02-audit-native-commerce.log`，0.2.0-test59，已確認 CLI 含最後 systemd guard。
- Docker：`/tmp/storeweave-b02-final-docker-base.log`、`/tmp/storeweave-b02-final-docker-commerce.log`。最後 role／seed／CLI 修正由上述相應測試覆蓋；不宣稱舊 Docker image 含最後修正。
- 實際 Debian 安裝／移除：`/tmp/storeweave-b02-real-deb-install-final.log`。套件管理只持有獨立媒體，保留安裝後的 release／config；包裝之後未改。
- 獨立審查：`/tmp/storeweave-b02-standards-closure.json`、`/tmp/storeweave-b02-spec-closure.json`。
- 原 2,461 個 release 檔案 SHA 未變：`/tmp/storeweave-b02-final-preserved-release-check.json`；未新增外部依賴、未 commit／push／部署或變更外部商戶 DB。

## 明確限制

還原需要 PostgreSQL 17、maintenance superuser、既有 roles／extensions／tablespaces，並停妥管理中服務與外部寫入者。
歷史 B01 SQL/runtime bytes 無法追溯驗證，採納 flags 保持 false。Release 摘要不是發行者簽章。
還原會替換整個資料庫；快照後資料保留在 quarantine，不合併、不自動 DROP、不執行任意 down migration。
這些限制與完整 Base 尚待完成的 B03–B17，均不因 B02 局部驗收而消失。
