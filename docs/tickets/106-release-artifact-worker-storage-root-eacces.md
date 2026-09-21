# 106 — Commerce release artifact worker 測試的 storage root 權限錯誤

**What to build:** 查明並修正 `tests/integration/release-artifacts.test.ts` Commerce worker smoke case 在測試環境建立 storage root 時的權限失敗，保留真實子程序啟停與 cleanup 驗證。

**Status:** observed（2026-09-21；完整 `make verify` 中重現一次，根因未確認）

## Acceptance

- [ ] 在完整 integration suite 與單檔重跑中取得可比較的 storage root 設定及 child process 證據。
- [ ] 確認是測試隔離、release 設定或 production cleanup 路徑哪一層導致錯誤；不預設根因。
- [ ] 以最小修正讓 Commerce worker 使用可寫且隔離的測試 storage，同時保留 worker cleanup 與 shutdown assertion。
- [ ] `tests/integration/release-artifacts.test.ts` 與 `make verify` 通過。

## Evidence

2026-09-21 完整 `make verify` 的 `commerce: four bundles, repeatable seed, API/worker lifecycle and listen failure` case 中，worker 記錄 `EACCES: permission denied, mkdir '/var/lib/commerce'`，接著 SIGTERM 後報告 cleanup failure 與 2 秒 shutdown deadline exceeded，`processSmoke` 第 32 行收到 exit code 1。尚未證明是哪個設定令這支測試使用 `/var/lib/commerce`。

該次完整 gate 結束後單獨重跑 `tests/integration/release-artifacts.test.ts`，6 tests 全數通過（約 68 秒），Commerce worker case 也通過。失敗目前只在完整 suite 執行下觀察到，根因仍未確認。

2026-09-21 第二次完整 `make verify` 中，此檔 6 tests 再次全數通過，包含 Commerce worker smoke case。這項失敗目前僅有一次完整 suite 重現，沒有已確認根因。
