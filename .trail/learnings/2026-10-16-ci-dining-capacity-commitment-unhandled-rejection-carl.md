---
title: CI 整合測試全綠卻失敗：dining-capacity-commitment 的 unhandled rejection
author: Carl
date: 2026-10-16
branch: main
cost: { minutes: 2, tokens: 59771 }
touches:
  - AGENTS.md
  - opencode.json
  - tests/integration/dining-capacity-commitment.test.ts
---

## Decided
- PR #131 的 `integration shard 2/2` 失敗與 PR 改動無關：560 個測試全過，但 Vitest 抓到 1 個 Unhandled Rejection（CONFLICT 409）就以 exit 1 結束。
- 根因（推論，未本機重現）：`tests/integration/dining-capacity-commitment.test.ts` 的 "serializes competing acceptances..." 先建立 `secondAcceptance` / `reduction` 兩個 Promise，`release()` 之後才逐一 `await expect(...).rejects`；`reduction` 若先拿到 venue lock 並 reject，當下沒有處理器。
- 修法方向：在 `release()` 前就把 `expect(...).rejects` 掛上，再用 `Promise.all` 等待；依 AGENTS.md 另開 issue 與分支修，不併進無關 PR。

## Tried and ruled out
- gh-fix-ci 的 `inspect_pr_checks.py` 抓到的片段是整個 run 混雜的日誌（顯示 smoke native），不是失敗 job；改用 `gh run view <run> --job <job> --log` 再 grep "Unhandled|Errors".

## Watch out
- 「Test Files 全 passed」但 `Errors  1 error` 時，要找 Unhandled Rejection 區塊，不是失敗的斷言。
- `integration (postgres)` 是彙總 job，只反映 shard 的結果。
