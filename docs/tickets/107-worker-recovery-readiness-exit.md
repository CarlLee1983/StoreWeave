# 107 — Worker recovery 子程序在 ready marker 前退出

**What to build:** 找出 `tests/integration/worker-recovery.test.ts` heartbeat-fencing case 為何在輸出 `ready` 前以 `fatal:worker tick failed` 退出，保留 process-failure 與可回收 lease 的 acceptance。

**Status:** observed（2026-09-21；完整 `make verify` 中重現一次，根因未確認）

## Acceptance

- [ ] 在完整 integration suite 及單檔重跑中保留 worker 子程序退出碼、signal、ready marker、heartbeat 與 lease evidence。
- [ ] 以證據區分測試同步／環境負載與 worker heartbeat 行為；不降低 fenced heartbeat assertion。
- [ ] 修正經確認的根因，並保留 process failure 後 lease 可 recovery 的行為。
- [ ] `tests/integration/worker-recovery.test.ts` 與 `make verify` 通過。

## Evidence

2026-09-21 完整 `make verify` 的 `process-fails when a fenced heartbeat is blocked and leaves the lease for recovery` case，在 `waitForOutput` 等待 `ready` 時發現子程序已退出；輸出為 `fatal:worker tick failed`、`draining`。測試當次未顯示 heartbeat SQL 或 lease 狀態，不能據此判定 production worker 根因。

該次完整 gate 結束後單獨重跑 `tests/integration/worker-recovery.test.ts`，8 tests 全數通過（約 50 秒）；heartbeat-fencing case 也通過。失敗目前只在完整 suite 執行下觀察到，根因仍未確認。

2026-09-21 第二次完整 `make verify` 中，此檔 8 tests 再次全數通過，包含 heartbeat-fencing case。這項失敗目前僅有一次完整 suite 重現，沒有已確認根因。
