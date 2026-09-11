# 99 — 一個指令代表「做完了」

**What to build:** StoreWeave 今天沒有任何一個指令回答得了「這份改動可以送審了嗎」。完成條件散在 `.github/workflows/ci.yml` 的兩個 job、六個指令裡，本地要自己拼——工單 98 的實作過程就發生過一次：執行者得自己判斷哪幾支測試算數、整合測試要不要跑、跑完算不算通過。這張票給出那個指令。

採用 ForgeFlow 的 repository contract 所需的驗證那一半，不含 Story 格式。決策與實測見 [discovery](../research/91-forgeflow-protocol-adoption.md)。

**Blocked by:** 91

**Status:** ready-for-agent

- [ ] 根目錄新增 `Makefile`，露出 `verify`：`typecheck`、`typecheck:admin`、`test`、`test:admin`、`test:integration` 五支，任一支非零就整個非零
- [ ] 會改寫原始碼的指令不得放進 `verify`——驗證不能靠改檔案換到 PASS（`protocol/verification.md`）
- [ ] 根目錄新增 `AGENTS.md`：告訴 coding agent 遵循工單範圍、測試改動過的行為、以 `make verify` 為完成權威
- [ ] `ci.yml` 改呼叫 `make verify` 而不是維護第二份完成定義；兩支 smoke 維持獨立 job
- [ ] CI 的實際行為與現在等價——不是「看起來一樣」，是同一組檢查都還在跑
- [ ] ForgeFlow Doctor 的 static 模式不再報 `Makefile is missing` 與 `AGENTS.md is missing`

## 這張票不做的

不新增 `specs/stories/`、不碰 Story 格式、不改任何 ADR 的檔名或狀態行、不轉換既有工單。
那些屬於工單 100 與它之後的評估。

`make verify` 跑完約 18 分鐘（實測 unit ~103s、integration ~961s），這是刻意的選擇：
這次工單 98 唯一的失敗（`release-transition` 的 active owner 數）是 integration 抓到的，
unit 全綠。把它排除等於讓 PASS 的意義弱於現在的 CI。想要快回饋就直接跑個別的 pnpm script，
但那不是 PASS。

## 邊界

`Makefile` 與 `AGENTS.md` 是新檔案，`ci.yml` 是唯一被改動的既有檔案。
rollback 就是刪掉兩個新檔並把 `ci.yml` 改回直接呼叫 pnpm scripts。
零 dependency、零 migration、零 runtime 變更。
