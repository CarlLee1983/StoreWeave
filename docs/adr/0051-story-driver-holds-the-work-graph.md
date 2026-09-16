# 0051. 工作圖與順序由 Story Driver 持有，Story 只描述一件工作

- 狀態：accepted（決策 1 與 3 於 2026-09-16 更正，見文末）
- 日期：2026-09-15

## 背景

工單 99 已經採用了 ForgeFlow 協定的驗證那一半：`make verify` 是完成的唯一定義，`AGENTS.md` 是
agent 的指令書，`Makefile` 的規則刻意寫成字面值好讓 Doctor 靜態掃描。Story 那一半留在工單 100，
狀態 `blocked`，等「B14 的第一張工作確定是什麼」——B14 已於 2026-09-11 `done`，這個 blocker
已經消失，但沒人回去解。

同一時間上游改名了：ForgeFlow 於 2026-09-15 更名為 PraxisBound（ADR-011，原因是拿不到
`@forgeflow` npm scope），protocol 版本 `0.9.0` → `0.10.0`，是 breaking change，**沒有永久相容別名**，
`FORGEFLOW_*` 環境變數非空會 fail closed。StoreWeave 現有的採用全部是改名前的字樣。

實際要接上去時，落差出現在三處：

- PraxisBound 明文**不持有工作目前處於什麼狀態**。`protocol/lifecycle.md` 的
  `DRAFT → READY → IMPLEMENTING → VERIFYING → REVIEW → DONE` 只是共享詞彙，禁止持久化到 repo；
  Story、acceptance、task note、handoff 都不准寫 current／next／status／Gate／completion。
  current state 屬於外部 control plane（上游舉 ForgePilot 為例），沒有 control plane 時就是人類直接指揮。
- 因此「下一張是哪一張」沒有現成答案。工單 100 原本打算自己寫 `scripts/story-check` 與
  `scripts/verification-check`，那是重造上游已有的腳本，而真正缺的其實是排序。
- Story 的 `Dependencies` 欄位是散文。上游自己的範例 `TYP-001` 寫的是「The existing
  `calculateOrderTotal` implementation and the PraxisBound Story Contract」——拿不出 Story ID，
  無法做拓撲排序。

## 決策

1. **StoreWeave 是 PraxisBound 的 external control plane，這個角色叫 Story Driver。**
   PraxisBound 管一張 Story 怎麼做完並留下證據；Story Driver 持有工作圖、決定順序、挑出下一張並派工。
   它住在 `scripts/story-driver.mjs`，但**對 StoreWeave 零耦合**：只准依賴 `specs/stories/` 的目錄契約、
   `make verify` 這個介面、以及 `praxisbound … --json` 的輸出（schema `urn:praxisbound:cli-result:1`）。
   位置在本 repo 是因為目前只有一個使用者，過早的 repo 邊界會讓每次調整變成跨 repo 同步；
   零耦合是為了將來抽出去是搬檔案，不是重寫。

2. **全採 PraxisBound 0.10.0，不自寫協定工具。** 跑 `bootstrap` 與 `codex-activate --apply`，接受
   `.agents/skills/praxisbound/`、marker `specs/.praxisbound-adoption`、`AGENTS.md` 的受管區塊，
   以及 `story-check`／`verification-check`／`doctor`。工單 100 自寫這兩支腳本的計畫作廢。

3. **意圖與狀態分開存放。** 意圖（有哪些工作、誰先誰後）存在 `specs/graph.toml`，機器可讀的依賴邊
   **只**寫在這裡；Story 的 `Dependencies` 欄位維持散文給人讀。狀態（做到哪、結果如何）**不儲存**，
   每輪推導，判準三條：`story-check --ready` 通過且該 Story 目錄無 `verification.md` → 候選；
   `verification-check --result` 回 PASS 且該 branch 已 merge 進 `main` → 完成；PASS 但未 merge →
   停下等人 review，Driver 不往下走。第三條讓「只有人類能推進 DONE」成為 Driver 擋得住的事，
   而不只是一句原則。

4. **執行迴圈分兩階段。** 第一階段 Driver 只算出下一張並印一行可貼的指令，實作由人開 session；
   格式站穩後再升級成 Driver 自行 spawn headless agent。Driver 吃 `--agent codex|claude`，
   **Story 檔案內絕不標註由哪個 agent 執行**——agent 中立是 PraxisBound 的核心主張，
   寫死廠商會讓「同一張 Story 換個 agent 重做」變得不可能。

5. **隔離與授權。** 每張 Story 一個 branch `story/SW-xxx`，做完發 PR。Story 的 authority 宣告
   `commit: yes`、`push: yes`、`deploy: no`；merge 永遠由人執行。

6. **失敗處理有上限，且 agent 不得改需求脫困。** 門檻是 `make verify` 綠燈加一次 code-reviewer
   掃 CRITICAL／HIGH。上限 **2 次實質失敗**，第 3 次交人類。環境失敗——Docker daemon 不可用、
   Testcontainers 在啟動階段失敗——**不重試、不計入上限**，立刻停並記 `not-run`，沿用
   `docs/base/b17/acceptance.md` 既有的規則「不改寫程式碼來取得綠燈」。**agent 永遠不准為了通過驗證
   而修改 Story 或弱化測試**；SPEC_BLOCKED 只有人類能認定。

7. **四套識別並存且不對稱。** Spec 是需求與驗收的唯一來源；Story 是一個 agent 一次做得完、
   有 AC 有證據的執行單位，ID 為單一前綴 `SW-001` 起；Ticket 是歷史存檔，不再新增，既有 01–100
   一張都不轉換；工作包 `B00–B17` 是本機規劃識別，B17 收尾後不再新增。Story 的粒度規則：
   In Scope 只能碰一個 package 邊界，跨邊界就拆；模組宣告與 release 授予之間的接線型 Story 是
   明確標註的例外。

## 後果

- 工單 100 解除 blocked，內容改寫為本決策；`specs/stories/` 與 `specs/graph.toml` 由第一張 Story 建立。
- `AGENTS.md` 會被 `codex-activate` 插入一段受管區塊，該區塊不得手改，否則下次 activate 會在寫入前拒絕。
- `docs/specs/README.md` 的 `ready-for-agent` 語意是「spec 已可派工」而非「未完成」。這個值讀起來像待辦，
  Driver 不得拿它當候選工作的訊號；欄位需要改名或改值。
- 眼前可餵進迴圈的工作很少：100 張 Ticket 有 94 張已完成，其餘 8 張卡在商家與綠界的外部開通與 UAT，
  agent 幫不上。第一批 Story 取自 `docs/base/b17/acceptance.md` 的技術性 pending 項。
- 這條迴圈的目的是重用到下一個真實案子（Spec 0009 的通用應用基底），現在先以 B17 的剩餘工作試跑格式。
- **執行暫緩，決策不變。** 採用時機押在兩個外部條件上：PraxisBound 正在重構為 npm 套件，`@praxisbound/cli` 目前只遷移了 `handoff check`、`init`、`codex activate`、`doctor`、`verify`、`verification check`、`release check`，其餘子命令寫 usage 診斷並 exit 2；而 StoreWeave 這側沒有
  真實 Story 可餵——100 張 Ticket 有 94 張完成，其餘卡在外部開通。兩者任一未解除前不 bootstrap、
  不建 `specs/stories/`、不寫 `scripts/story-driver.mjs`。解除條件：上游 CLI 遷移完成且介面穩定，
  並且出現第一個真實案子或 B17 剩餘工作確定作為試跑材料。

## 2026-09-16 更正：ForgePilot 已經是這個控制平面

寫這篇時我沒有查到 `CarlLee1983/ForgePilot`（本機 `/Users/carl/Dev/CMG/ForgePilot`），
只搜了 `/Users/carl/Dev/Carl` 一棵樹。它的自我描述就是本篇決策 1 要蓋的東西：
「Engineering Control Plane — durable work queue, verification evidence bound to exact
revisions, and human decision gates」。Go、零外部相依、318 個測試、23 篇 ADR，
並且已在 AgentPort（16 個 Work Item 全 DONE、67 筆 Evidence、34 個 Gate）與
Dbcli（27 個 Work Item 全 DONE、81 筆 Evidence）上實跑過。

因此兩件事要改：

**決策 3 的「狀態不儲存」是一次誤推，此處更正。** PraxisBound 的 `protocol/lifecycle.md`
禁止的是把 current／next／status／Gate／completion 寫進 **Story 檔案**，不是禁止控制平面
持有狀態——它明文把 current state 指給外部 control plane。ForgePilot 把狀態存成
`.forgepilot/state.json`（schema v8、flock＋原子替換、`init` 時寫進 `.gitignore`），
完全符合該規則。本篇原本寫的「不儲存、每輪由證據推導」把「不寫進 Story」錯推成
「完全不存」，那三條推導判準因此是解決一個不存在的限制。

**決策 1 重開為未決問題。** 在「採用 ForgePilot」與「在 StoreWeave 自寫
`scripts/story-driver.mjs`」之間尚未選定；在選定之前，兩者都不動工。已知的落差是
ForgePilot 目前綁的仍是 ForgeFlowV2：全 repo grep `praxisbound`、`story-check`、
`verification-check` 零命中，`internal/repository/repository.go:31-33` 只硬編碼檢查
`<root>/specs/stories` 是否存在、不解析 Story 內容也不呼叫任何 CLI，其 `CONTEXT.md`
自承尚未真正接上（ADR-0013）。狀態名亦不同：PraxisBound 的 `DRAFT`／`IMPLEMENTING`
在 ForgePilot 是 `PENDING`／`RUNNING`。此外 ForgePilot 只有 `codex` 與測試用 `fake`
兩個 runtime，沒有 claude adapter；其 budget 是 `max_attempts_per_work 3`，
與本篇決策 6 的上限 2 不同。

其餘決策（2、4 的 agent 中立、5、6 的「agent 不得改需求脫困」、7）不受此更正影響。

## Falsified if

`scripts/story-driver.mjs` 開始 import StoreWeave 自己的 package、或讀取 `specs/stories/`、
`specs/graph.toml`、`make verify`、`praxisbound --json` 以外的來源，則第 1 點的零耦合不再成立，
Driver 應改為獨立 repo。若 `specs/graph.toml` 以外的地方出現機器可讀的 Story 依賴邊——例如
`specs/stories/` 內任何檔案被程式解析出 `SW-\d+` 當排序依據——則第 3 點的單一真相已破。
若 `specs/stories/` 下任何檔案出現 current／next／status／Gate／completion 這類可變生命週期欄位，
本決策與 PraxisBound 的 `protocol/lifecycle.md` 同時被違反。若 `specs/.praxisbound-adoption` 消失，
或 `Makefile` 的 `verify` 目標不再是唯一完成定義，第 2 點需重開。
