# 99 — 一個指令代表「做完了」

**What to build:** StoreWeave 今天沒有任何一個指令回答得了「這份改動可以送審了嗎」。完成條件散在 `.github/workflows/ci.yml` 的兩個 job、六個指令裡，本地要自己拼——工單 98 的實作過程就發生過一次：執行者得自己判斷哪幾支測試算數、整合測試要不要跑、跑完算不算通過。這張票給出那個指令。

採用 ForgeFlow 的 repository contract 所需的驗證那一半，不含 Story 格式。決策與實測見 [discovery](../research/91-forgeflow-protocol-adoption.md)。

**Blocked by:** 91

**Status:** done

- [x] 根目錄新增 `Makefile`，露出 `verify`：`typecheck`、`typecheck:admin`、`test`、`test:admin`、`test:integration` 五支，任一支非零就整個非零
- [x] 會改寫原始碼的指令不得放進 `verify`——驗證不能靠改檔案換到 PASS（`protocol/verification.md`）
- [x] 根目錄新增 `AGENTS.md`：告訴 coding agent 遵循工單範圍、測試改動過的行為、以 `make verify` 為完成權威
- [x] `ci.yml` 改呼叫 `make verify` 而不是維護第二份完成定義；兩支 smoke 維持獨立 job
  （實作上 CI 呼叫的是 `verify` 的各個子目標，見下方「CI 為什麼不直接跑 `make verify`」）
- [x] CI 的實際行為與現在等價——不是「看起來一樣」，是同一組檢查都還在跑
- [x] ForgeFlow Doctor 的 static 模式不再報 `Makefile is missing` 與 `AGENTS.md is missing`

## 這張票不做的

不新增 `specs/stories/`、不碰 Story 格式、不改任何 ADR 的檔名或狀態行、不轉換既有工單。
那些屬於工單 100 與它之後的評估。

`make verify` 跑完約 18 分鐘（實測 unit ~103s、integration ~961s），這是刻意的選擇：
這次工單 98 唯一的失敗（`release-transition` 的 active owner 數）是 integration 抓到的，
unit 全綠。把它排除等於讓 PASS 的意義弱於現在的 CI。想要快回饋就直接跑個別的 pnpm script，
但那不是 PASS。

## CI 為什麼不直接跑 `make verify`

原本 CI 把 integration 切成兩個 shard 平行跑。若 CI 單一 job 呼叫 `make verify`，
檢查組合不變，但整合測試失去 sharding、wall-clock 大約加倍。使用者選擇保留 CI 的 job 拓樸：
`Makefile` 仍是唯一的完成定義，`verify` 由五個子目標組成；CI 的 check job 呼叫
`make typecheck`／`typecheck-admin`／`test`／`test-admin`，integration job 呼叫
`make test-integration-shard-1`／`-2`，兩者合起來等於 `test-integration`。

## 驗收紀錄（2026-09-11）

- `make -n` 展開後，CI 的四支 check 指令與改動前逐字相同；integration shard 由
  `pnpm exec vitest run --project integration --shard=N/2` 改為 `pnpm test:integration --shard=N/2`，
  展開成同一條 vitest 指令（pnpm 會把多的參數轉給 script），shard 因此跟著 `test:integration` 走；job、matrix、兩支 smoke 與
  `integration (postgres)` summary job 都沒動
- 本機 `make verify` exit 0：unit 1134 passed（203s）、admin 350 passed（182s）、
  integration 854 passed（1226s），兩支 typecheck 通過。整合測試比 discovery 時的 961s 慢，
  全套約 27 分鐘，不是票上原估的 18 分鐘
- 失敗路徑：用假的 `pnpm` 讓 `test:admin` 回 3，make 停在該步、不跑 integration，整體 exit 2
- `.NOTPARALLEL:` 擋住 `make -j verify` 讓三套測試並行
- Doctor static：`Makefile is missing` 與 `AGENTS.md is missing` 消失，回報
  `Found a literal verify rule`，沒有 static inspection 受限的 WARN；
  仍是 `STRUCTURE_INCOMPLETE`，只缺 `specs/stories/`（工單 100）

## 邊界

`Makefile` 與 `AGENTS.md` 是新檔案，`ci.yml` 是唯一被改動的既有檔案。
rollback 就是刪掉兩個新檔並把 `ci.yml` 改回直接呼叫 pnpm scripts。
零 dependency、零 migration、零 runtime 變更。
