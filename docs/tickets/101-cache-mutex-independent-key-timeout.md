# 101 — Advisory mutex 的獨立 key 整合測試偶發取得逾時

**What to build:** 讓 `tests/integration/cache-and-mutex.test.ts` 中「不同 key 可同時持有鎖」的整合測試在完整整合測試負載下仍能穩定驗證獨立 key，並確保 assertion 失敗時也會釋放測試中的 holder callback。保留 PostgreSQL advisory mutex 的鎖定語意；不要以重試掩蓋逾時。

**Blocked by:** —

**Status:** completed locally（2026-09-23 同一失敗於 ForgePilot `VR-015`／`EV-018` 再現後重開並修正）。

- [x] 以受控 query 延遲重現 `inventory` / `sku:43` 的 100ms acquisition timeout，將此測試的獨立 key deadline 改為有限的 5 秒；holder 保持未釋放，維持可偵測錯誤串行的斷言。
- [x] 測試失敗路徑在 `finally` 釋放並等待 `sku:42` holder，避免 `afterEach` 因未結束的 callback 再次逾時。
- [x] 驗證同 namespace 不同 key 可併行、相同 key 仍互斥、已取消 waiter 不執行 callback。
- [x] `make verify` 通過。

## 結案決策

2026-09-22，Carl Lee 決定在未確認根因、未修改 mutex 或測試的情況下結案。本票的
未勾選項目仍是尚未完成的驗收，不得解讀為 timeout 已修正或 `make verify` 已在本票
變更後通過。若同一個 `inventory` / `sku:43` 100ms timeout 再次出現，應重開本票並
以當次已遮蔽的完整輸出建立可重現的診斷迴路。

2026-09-23 ForgePilot `VR-015`／`EV-018` 再次遇到相同的 `sku:43`
acquisition timeout，且因 holder gate 未釋放又產生 300 秒 hook timeout；依前述
條件重開本票。此結果不能單憑一次正式驗證判定主機負載是唯一根因。

## 觀察到的證據

2026-09-20 的一次 `make verify` 在 typecheck、unit（1252 tests）與 admin（350 tests）通過後，integration 有 901/902 tests 通過。唯一失敗位於 `tests/integration/cache-and-mutex.test.ts` 的「allows independent keys concurrently and aborts waiters before their callback runs」：第二把 `inventory` / `sku:43` 鎖在 `waitTimeoutMs: 100` 內回報 `Mutex acquisition timed out`。此 assertion 失敗後，`sku:42` holder 的 gate 沒有被釋放，`afterEach` 關閉 manager 也逾時。2026-09-21 的完整 `make verify` 中，此檔 12 tests 全數通過。

失敗後以相同環境重跑該單一測試，及整個 `cache-and-mutex.test.ts`（12 tests），兩者皆通過。這些結果支持此測試可能對整合測試期間的負載或資料庫排程敏感，尚未證明具體根因。`packages/platform/cache/src/index.ts` 與該測試未屬於當時的 SW-105 變更。

2026-09-21 後續 `make verify` 再次在同一 case 失敗：第二把 `inventory` / `sku:43` 鎖於 `waitTimeoutMs: 100` 回報 `Mutex acquisition timed out`；`afterEach` 關閉 `sku:42` holder 時又超過 300 秒 hook timeout。這是已知問題的再次重現，不代表 production mutex 根因已確定。

該次完整 gate 結束後單獨重跑整個 `cache-and-mutex.test.ts`，12 tests 全數通過（約 17 秒）。這仍支持負載敏感假設，但尚未確認根因。

2026-09-21 第二次完整 suite 重跑時，`cache-and-mutex.test.ts` 12 tests 全數通過（約 5 秒），整個 integration suite 也通過。根因仍未確認。

2026-09-22 執行 `make test-integration`：111 個檔案、942 個測試全數通過（1262 秒）；
`cache-and-mutex.test.ts` 12 tests 全數通過（5799ms），目標 case 為 399ms。先前也以
同一個目標 case 進行單次聚焦執行並通過（721ms）。本次仍未重現原始的 100ms timeout，
所以不能據此判定根因或調整 production mutex／測試 deadline。

## 邊界

本票只處理上述 mutex 整合測試及其最小必要測試設施。不要順帶更改 production mutex 行為；若診斷證明 production 行為本身有錯，先更新本票範圍與證據再實作。不要把此次單一失敗描述成 `make verify` 的穩定失敗。

## 重開後的驗證

- 同一候選先前直接 `make verify` 的 integration 989/989 通過；`VR-015` 的
  unit 1452/1452、admin 351/351 通過，integration 988/989，唯一失敗為本票案例。
- 聚焦案例原樣重跑通過。測試內只對第二個 mutex 的 acquisition query 注入
  150ms 延遲後，100ms deadline 在 `packages/platform/cache/src/index.ts:520`
  以相同訊息確定變紅，約 0.3 秒結束且不再發生清理 hook 逾時。
- deadline 改為 5 秒後，同一受控延遲聚焦案例通過。這證明 100ms
  測試預算對正常查詢延遲敏感，不證明正式失敗一定由主機負載造成；
  production mutex 的 deadline 與 advisory lock 語意均未改動。
- 調整後全檔 integration 12/12 與型別檢查通過；ForgePilot
  `VR-016`／`EV-019` 的完整 snapshot `make verify` 通過（unit 1452、
  admin 351、integration 989），其中本檔 12/12 通過。
