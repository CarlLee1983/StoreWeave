# 102 — Paired upgrade crash-injection test 偶發未收到 SIGKILL

**What to build:** 找出並修正 `tests/integration/cli-upgrade-paired.test.ts` 在完整序列化 integration suite 偶發未收到預期 `SIGKILL` 的原因。保留真實 CLI、paired snapshot 與 crash-recovery 行為；不可放寬 assertion 或用重試掩蓋錯誤。

**Blocked by:** —

**Status:** observed（2026-09-20；完整 `make verify` 一次失敗，兩次單檔重跑通過）

- [ ] 在完整 `make verify` 負載重現 `rollback --resume` 的 crash-after-commit 失敗並保存完整、已遮蔽敏感值的子程序錯誤資訊。
- [ ] 依證據確認是測試 hook／marker、子程序執行環境或 CLI transition 行為的問題；記錄能推翻根因判斷的觀察。
- [ ] 修正經重現確認的原因，不降低 crash-recovery assertion。
- [ ] `make verify` 通過。

## 觀察到的證據

2026-09-20 的一次 `make verify` 在 typecheck、unit（1259 tests）與 admin（350 tests）通過後，integration 有 903/904 tests 通過。唯一失敗位於 `tests/integration/cli-upgrade-paired.test.ts` 第 228 行：對 `rollback --resume ...` 的 crash-after-commit 注入預期 rejection 含 `signal: 'SIGKILL'`，實際錯誤的 `signal` 為 `null`。失敗發生於完整 integration suite 約 954 秒的執行期間；當次輸出未提供足以判定子程序為何沒有回報該 signal 的完整錯誤欄位。

之後以相同命令單獨重跑此測試兩次，兩次皆通過（約 82 秒及 80 秒）。2026-09-21 再次執行完整 `make verify` 時，此測試也通過；全套 integration 107 files / 904 tests 通過。這些結果尚未證明根因，也不能把單次失敗歸因到當前 worker projection 改動。

## 待驗證假設

1. 完整 suite 後段的系統或子程序負載影響 child process 結束回報；若單檔重跑可穩定失敗，則此假設不成立。
2. `crash-after-commit` marker／hook 在該次執行中沒有命中預期 journal phase；若取得當次完整 hook 與 journal 證據顯示已命中，則此假設不成立。
3. 此平台在該次執行中以不同方式呈現 child exit；若相同環境下重複執行仍只在完整 suite 失敗，需比較失敗當次與成功當次的完整 `execFile` error 欄位及 CLI 輸出。

這些是假設，不是根因結論。先以能保留當次錯誤證據的重現方式診斷，再決定最小修正。

## 邊界

本票只處理 paired upgrade integration test 暴露的 crash-after-commit 行為。不要順帶更改 release projection、一般 rollback 行為或其他 transition 測試；若證據顯示 CLI production 行為有錯，先更新此票的範圍與根因證據再實作。
