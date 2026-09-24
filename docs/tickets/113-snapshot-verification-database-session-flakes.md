# 113 — Snapshot 驗證的 PostgreSQL session／cutover 時序不穩定

**問題：** 2026-09-23 的 ForgePilot Node 22 snapshot 完整驗證中，同一份 Booking
候選曾全套通過，但後續對 WI-015 的三輪驗證分別在不同的既有 integration
測試失敗。失敗集中於 500ms heartbeat 資料庫逾時，以及 restore/cutover
偵測仍存活的 PostgreSQL session；聚焦重跑個別失敗檔案可通過。原因尚未
確認，不能只用「本機負載」推定產品或測試無誤。

**狀態：** 偶發原因待診斷。WI-015 已在 `VR-011` 取得完整 snapshot PASS，
但此前失敗未能穩定重現，不能宣稱根因已修復。不要放寬 cutover 的無連線
安全要求、跳過測試或把聚焦重跑當成 `make verify` 通過。

## 驗收

- [ ] 釐清 `full-restore`、`pg-tool` 與 `database-cutover` 的 PostgreSQL session
      生命週期；失敗時能分辨預期的 late connection、尚未關閉的 fixture/runtime
      pool，以及真正應阻止 cutover 的使用者連線。
- [ ] 修正測試資源清理或擁有該行為的邊界，使 cutover 的安全拒絕與相應
      integration 測試在完整套件下穩定、可判定；不得弱化驗證條件。
- [ ] 查明 `queue-retention` heartbeat 500ms 逾時是否為環境負載或其他
      生命週期／鎖等待問題，並用可重現的證據處理。
- [x] Node 22 的 `make verify` 完整通過，再以 ForgePilot snapshot 取得
      WI-015 的 fresh PASS；失敗紀錄保持可追溯。後續候選變更仍需重新檢查 freshness。

## 證據與邊界

- `VR-007`／`EV-007`：同一候選的完整 `make verify` 通過；integration
  112 檔、989 個測試全綠，WI-014 驗證通過。
- `VR-008`／`EV-009`：`queue-retention.test.ts` 的 running cancellation
  heartbeat 操作超過 500ms；該檔聚焦重跑 6/6 通過。
- `VR-009`／`EV-010`：`database-cutover.test.ts` 預期在後段 rename 遇到
  late connection，實際在前段無 session 檢查被安全拒絕；該檔聚焦重跑
  2/2 通過。
- `VR-010`／`EV-011`：`full-restore.test.ts` 與 `pg-tool.test.ts`
  均因 `Cutover requires all live and scratch database sessions to be closed`
  失敗。這三輪完整驗證當時都未讓 WI-015 通過。
- 三檔聚焦組合 6/6、`full-restore` 單檔連續八次及受控並行三次皆通過；
  無法藉此推定偶發原因。短暫加入的診斷探針只在預期拒絕案例捕到 idle
  client backend，已移除，`tools/cli/src/database-cutover.ts` 無留下 diff。
- 後續 Node 22 的診斷版 `make verify` 通過；移除探針後 ForgePilot
  `VR-011`／`EV-012` 在固定 snapshot 完整通過，integration 112 檔、
  989 個測試全綠；WI-015 驗證通過，WI-013／014 也取得共享 fresh PASS。
- ForgePilot `VR-025`／`EV-040` 在 WI-017 快照的 integration 112 檔中
  111 檔通過，`cli-legacy-upgrade.test.ts` 的 raw snapshot 案例原本預期
  `SIGKILL`，實際先被 cutover 的殘留 session 安全檢查拒絕；同一檔在主工作樹
  聚焦重跑 2/2 通過。此結果仍不能替代完整 gate PASS。
- 本票不修改 Booking HTTP、Quote signer、Reservation 權限或 ForgePilot
  goal/DAG；相關工單的驗證狀態不得由本票提前解除。
