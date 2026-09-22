# 101 — Advisory mutex 的獨立 key 整合測試偶發取得逾時

**What to build:** 讓 `tests/integration/cache-and-mutex.test.ts` 中「不同 key 可同時持有鎖」的整合測試在完整整合測試負載下仍能穩定驗證獨立 key，並確保 assertion 失敗時也會釋放測試中的 holder callback。保留 PostgreSQL advisory mutex 的鎖定語意；不要以重試掩蓋逾時。

**Blocked by:** —

**Status:** closed without corrective change（2026-09-22；Carl Lee 接受未重現的偶發測試風險）

- [ ] 在完整 `make verify` 負載下確認並修正 `inventory` / `sku:43` 獨立 key 的 100ms acquisition timeout。
- [ ] 確保測試失敗路徑會釋放 `sku:42` holder，避免 `afterEach` 因等待未結束的 callback 再次逾時。
- [ ] 驗證同 namespace 不同 key 可併行、相同 key 仍互斥、已取消 waiter 不執行 callback。
- [ ] `make verify` 通過。

## 結案決策

2026-09-22，Carl Lee 決定在未確認根因、未修改 mutex 或測試的情況下結案。本票的
未勾選項目仍是尚未完成的驗收，不得解讀為 timeout 已修正或 `make verify` 已在本票
變更後通過。若同一個 `inventory` / `sku:43` 100ms timeout 再次出現，應重開本票並
以當次已遮蔽的完整輸出建立可重現的診斷迴路。

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
