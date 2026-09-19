# 91 — ForgeFlow 協定採用 discovery

- 工單：[91](../tickets/91-forgeflowv2-integration-discovery.md)．Spec 0008 §6
- 調查日期：2026-09-11．StoreWeave runtime diff：零
- 來源：`/Users/carl/Dev/CMG/ForgeFlowV2`，VERSION `0.7.0`，commit `cb4bc97`（2026-09-09），MIT

## 結論先講

ForgeFlowV2 **不是 workflow engine、不是 UI library、不是工作佇列替代品**——Spec 0008 §6
擔心的三種推定都不成立。它是一份**開發協定**：把人核准過的意圖收成一張 Story，讓倉庫自己的
工具決定「做完了沒」，只把驗證過的工作送進人工審查。

因此「整合」不是接 adapter、加 dependency 或開 endpoint。StoreWeave 這一側要決定的是
**要不要採用一套流程契約**，而採用只依賴三樣東西：`AGENTS.md`、一份露出 `make verify`
的 `Makefile`、以及 `specs/stories/` 目錄。

建議**並存且不對稱**：先採用驗證那一半，Story 只用在新工作，既有 01–98 不轉換。理由在
〈建議〉一節，三處實測證據在〈實測〉。

## 它是什麼：責任與實際能力

| 項目 | 事實 | 來源 |
| --- | --- | --- |
| 產品類型 | agent-agnostic development protocol，不教 agent 寫程式、不綁 AI 廠商 | `README.md` |
| 流程 | `Human → Story → Agent implementation → Verify → Repair → PASS → Human review → Merge` | `README.md` |
| 交付形式 | 文件與 POSIX shell 檢查器，另帶 TypeScript／Go 範例；根目錄沒有 `package.json`，`examples/typescript/package.json` 只屬於範例 | `README.md` 「Adopt ForgeFlow」．`git ls-tree -r cb4bc97` |
| 契約 | story／verification／execution／architecture／lifecycle／handoff／repository-contract／versioning 八份 | `protocol/` |
| 工具 | `bootstrap`、`doctor`、`story-check`、`verification-check`、`handoff-check`、`release-check`、`codex-activate` 七支 shell script | `scripts/` |
| 授權 | MIT | `LICENSE` |

### 能力與運作邊界

下表把本票要求的能力一項項收旂；「無」是因為 ForgeFlow 在不同層，不是尚未實作的
StoreWeave runtime 功能。

| 面向 | 結論 | 固定來源（`cb4bc97`） |
| --- | --- | --- |
| API／SDK／事件／UI | 無 runtime API、SDK、event stream 或 UI／dashboard；可呼叫介面是 repo 內的 shell scripts 與檔案契約 | `protocol/repository-contract.md` 「Portability boundary」．`README.md` 「Check Story and handoff contracts」 |
| 執行／部署 | `bootstrap`、`doctor` 與各 checker 在使用者 checkout 中執行；adoption 是複製檔案到 target repo，不部署長駐服務 | `README.md` 「Adopt ForgeFlow」．`docs/doctor.md` 「Command forms」 |
| 認證／授權 | 沒有服務認證；Story 的 `Authority` 只是作業授權契約，不是身分認證機制 | `protocol/repository-contract.md` 「Portability boundary」．`protocol/execution.md` 「Authority」 |
| 錯誤 | checker 以 exit `0/1/2` 區分成功、契約不完整／驗證失敗、呼叫或運作錯誤；Doctor 再以具名 result label 區分結果 | `docs/contract-checks.md` 「Result semantics」．`docs/doctor.md` 「Results and decision boundaries」 |
| retry／idempotency | 沒有網路請求重試或 runtime idempotency；驗證失敗是修正後由執行者重跑 `make verify`，Doctor 單次呼叫不重試 | `protocol/verification.md` 「Repair loop」．`docs/doctor.md` 「Explicit local verification」 |
| 資料所有權 | 沒有 database 或 workflow state store；adopting repo 擁有 Story、`Makefile` 與選用 guidance，marker 只記錄複製的 version／revision | `protocol/repository-contract.md` 「Required surface」／「Verification ownership」．`protocol/lifecycle.md` 開頭 |

**明確的可攜界線**：「ForgeFlow does not require an agent runtime, workflow service, task
scheduler, database, dashboard, prompt format, or LLM abstraction. Repositories may add their
own tools, but adoption depends only on files, Make, and existing development and CI systems.」
（`protocol/repository-contract.md`）

### 採用所需的表面

```text
AGENTS.md
Makefile                  # 露出 make verify
specs/
└── stories/
    └── <story-id>/
        ├── story.md
        ├── acceptance.md
        └── task.md        # 選配
```

（`protocol/repository-contract.md`）

### 值得注意的五個機制

1. **`make verify` 是唯一的完成權威**（`protocol/verification.md`）。倉庫自己決定背後放什麼，
   但本地與 CI 呼叫同一個指令；協定只約束介面與 PASS／FAIL 語意，不指定語言、框架或 CI。
   會改寫原始碼的指令（自動格式化）必須留在 verify 之外，否則驗證會靠改檔案換到 PASS。
2. **綠燈不等於做完**（`protocol/verification.md` §Completion、`protocol/lifecycle.md`）。
   Story 進 REVIEW 需要「required check 全過」**且**「每一條 acceptance criterion 都有
   passing evidence」。少一條觀察就是 `PARTIAL`，而 partial 報成 done 被定義為協定違規。
3. **Risk 決定驗證面**：`low` 要 lint／static／unit，`medium` 加 integration，`high` 再加
   contract／e2e；倉庫沒有的層記成 `unsupported`，**不得記成 pass**。
4. **Authority 是逐項授權**（`protocol/execution.md`）：`plan`／`modify`／`add_dependency`／
   `migration`／`commit`／`push`／`deploy` 各自宣告，`review != fix`、`implement != commit`、
   `commit != push`、`push != deploy`。未宣告一律預設 `no`（除了 execution 模式的 plan／modify）。
5. **Architecture 是宣告不是分析**（`protocol/architecture.md`）：Story 可以宣告
   `Impact` 與它答辯的 `Decision`／`Boundary`／`Contract`／`Owner`；ForgeFlow 只負責記錄與解析
   引用，不評價架構。

## 對照 StoreWeave 現有接縫

工單 91 要求對照 Admin、HTTP、build-time Extension 三個接縫。**三者皆不適用**，理由不是
「不合身」而是「不同層」：那三個接縫是 runtime 的擴充點，ForgeFlow 不進 runtime。適用的
對照面是倉庫工具與文件流程。

| StoreWeave 現況 | ForgeFlow 對應 | 判定 |
| --- | --- | --- |
| `docs/tickets/*.md`（99 張，編號 + 中文敘事 + Status／checkbox／Blocked by） | `specs/stories/<ID>/story.md` + `acceptance.md` | **衝突**，見下 |
| `docs/adr/*.md`（既有 ADR 帶 `Falsified if`） | `specs/decisions/ADR-<digits>-<slug>.md`，可用 `FORGEFLOW_DECISIONS_ROOT` 指到既有目錄 | **部分可用**，被引用的 ADR 有兩處格式要處理 |
| `docs/specs/0001-0010` | 無對應概念；Story 之上沒有規格層 | 共存，不衝突 |
| `package.json` scripts（`typecheck`／`typecheck:admin`／`test`／`test:admin`／`test:integration`／`test:all`） | `make verify` 背後的實作 | **直接沿用**，包一層即可 |
| `.github/workflows/ci.yml`（typecheck+unit／integration ×2 shard／smoke docker／smoke native） | CI 應改呼叫 `make verify` 而非維護第二份定義 | 可沿用；StoreWeave 後來決定完成門檻必含 typecheck、unit、admin 與 integration |
| 根目錄無 `AGENTS.md` | 必要檔案 | **缺** |
| 根目錄無 `Makefile` | 必要檔案 | **缺** |

### `make verify` 補的是一個真實缺口

調查當天 StoreWeave **沒有任何一個指令代表「做完了」**。完成條件散在 `ci.yml` 的兩個 job、
六個指令裡，本地要自己拼。這不是理論問題：工單 98 的實作過程就發生過一次——執行者必須
自己判斷哪幾支測試算數、整合測試要不要跑、跑完算不算通過。

## 實測

三次都在唯讀模式下進行，StoreWeave 沒有任何檔案被修改。

### 1. Repository Doctor（static，預設模式）

```sh
cd /Users/carl/Dev/CMG/ForgeFlowV2 && ./scripts/doctor /Users/carl/Dev/Carl/StoreWeave
```

```text
FAIL  Agent guide is missing: AGENTS.md
FAIL  Story directory is missing: specs/stories/
FAIL  Makefile is missing
Result: STRUCTURE_INCOMPLETE          exit 1
```

**缺口恰好是三個必要路徑，都可以不改動既有 runtime 程式碼而補齊。** Doctor 的 static 模式明文
不跑 make、不碰網路、不動 Git（`docs/doctor.md`）。

### 2. ADR 引用解析：檔名不符

以一張只宣告 `Decision: ADR-0047` 的探針 Story，把 decision root 指到 StoreWeave 的 ADR 目錄：

```sh
FORGEFLOW_DECISIONS_ROOT=/Users/carl/Dev/Carl/StoreWeave/docs/adr ./scripts/story-check <probe>
FAIL  referenced decision record does not exist: ADR-0047
```

`scripts/story-check` 只找 `<root>/ADR-<digits>.md` 或 `<root>/ADR-<digits>-*.md`；
StoreWeave 的檔名是 `0047-session-is-a-page-outcome.md`，沒有 `ADR-` 前綴。

### 3. 只改檔名還不夠：狀態行格式也不符

把同一篇複製成 `ADR-0047-session-is-a-page-outcome.md`、內容一字不改：

```text
FAIL  referenced decision must declare Status exactly once: ADR-0047
```

ForgeFlow 期待 `* Status: <value>`；StoreWeave 寫的是 `- 狀態：accepted（…）`。

補上一行 `* Status: accepted` 之後：

```text
PASS  classification security=no baseline=no
Result: STORY_CONTRACT_OK             exit 0
```

這個 probe 只證明**被 Story 引用的既有 ADR**需要相容的檔名與英文狀態行；它沒有證明
所有 ADR 都必須改，也不應把 `docs/adr/README.md` 算成一篇 ADR。

### 附帶確認：Story ID 文法

探針用的 `SW-1` 通過檢查，所以 StoreWeave 可以用 `SW-98` 這種形狀。但既有的
`98-split-auth-view-and-close-system-page.md` 是裸數字開頭，**99 張全部不符合**
Story ID 文法（`protocol/story.md` 明文 `FF-1-2` 不合格，因為裸數字不是子系統名）。

## 建議

**並存且不對稱：先採用驗證那一半，Story 只用在新工作，01–98 一張都不轉。**

理由三條：

1. **`make verify` 獨立有價值。** 它補的是上面那個真實缺口，十行 Makefile，不改 CI 語意，
   而且就算最後不採用 Story 格式，這一項也該做。
2. **Story 格式對既有工單是退步。** `docs/tickets/*.md` 承載的東西 `story.md` 沒有欄位放：
   被推翻的做法、code review 擋下什麼、為什麼這個預設值是這個數字。README 本身是一份
   三百行的敘事史。Story 是結構化的執行契約，適合派工，不適合當歷史紀錄。
3. **轉換是純成本。** 99 張票要改名、重排成 story／acceptance 兩個檔案，而讀者是零——
   那些票的價值在於「以後有人問為什麼」時讀得到，不在於能被 `story-check` 解析。

## 最小驗證案例

一張 Story 走完 `DRAFT → READY → IMPLEMENTING → VERIFYING → REVIEW`，證明四件事：
`story-check` 對 StoreWeave 寫出來的 Story 回 `STORY_CONTRACT_OK`；`make verify` 在本地與 CI
得到相同結果；`verification-check --result` 認得每條 AC 的證據；Doctor 回 `STRUCTURE_OK`。

建議拿 B14 的第一張票當這個案例——它是真工作，不是示範用的空 Story。

## 失敗與 rollback

採用的足跡是 adopter 自有的 `Makefile`，以及 bootstrap 管理的 `AGENTS.md`、
`specs/.forgeflow-adoption`、`specs/stories/_template/` 與選用 `guidance/`。**沒有 dependency、
沒有 migration、沒有 runtime 變更**；rollback 需要按 marker 記錄的 snapshot 移除受管檔案，
再把 CI 改回直接呼叫 pnpm scripts。ForgeFlow 以 bootstrap 複製檔案進來，因此沒有
套件解析風險；但 pre-1.0 版本可以改變 Story Contract 與驗證門檻，升級仍需按
`protocol/versioning.md` 與 `docs/upgrading.md` 做 migration 與重驗。

## 調查當時的待決策事項

1. **`make verify` 背後放哪幾支？** 已決定：根目錄 `AGENTS.md` 與 `Makefile` 規定 typecheck、
   unit、admin 與 integration 全部是完成門檻；Story-specific 指令只能加速中途回饋，不另定 PASS。
2. **ADR 要不要改名對齊？** probe 證明被引用的 ADR 需要相容檔名與狀態行。不處理的話 Story 就不能用
   `Decision:` 引用既有決策，架構那一層的追溯性等於放棄。
3. **`Falsified if` 與 ForgeFlow 的 decision 格式如何共存？** StoreWeave 的 ADR 紀律比
   ForgeFlow 要求的多一層（可證偽條件 + 它指名的邊界檔案清單，見
   `~/.claude/rules/decision-records.md`）。ForgeFlow 不禁止，但也不認得，需要決定是否
   讓它進 `make verify`。
4. **Authority 宣告與現行習慣的落差。** ForgeFlow 預設 `commit: no`／`push: no`，要在 Story
   裡逐項授權。StoreWeave 目前的做法是工單完成後直接 commit，這會變成每張 Story 都要宣告。
5. **既有工單與新 Story 的入口如何並存？** 已決定：新工作看 `specs/stories/`，
   `docs/tickets/` 只保留歷史存檔（見 `CONTEXT.md`）。

## 下一份 spec 的範圍

以現行詞彙來說，建議拆成**兩張獨立 Story**，不要合成一張：

- **Story A（驗證基礎）**：bootstrap 受管檔案與 Story template、新增 `Makefile` 露出
  `verify`、`ci.yml` 改呼叫 `make verify`。不改既有 ADR。驗收是 Doctor 從
  `STRUCTURE_INCOMPLETE` 變成結構完整，且 CI 行為與原本等價。
- **Story B（Story 試點）**：用 Story 格式跑一張真工作，跑完回頭評估上面的待決策事項。

分開的理由是失敗歸因：Story A 失敗是採用或驗證基礎不完整，Story B 失敗是流程不合身；混在一起就分不出
是哪一個。

## 交付證據與剩餘風險

- **pass**：以 `git show`／`git ls-tree` 重看 ForgeFlowV2 `cb4bc97` 的 README、八份 protocol、
  Doctor／bootstrap 文件與 scripts；上述能力邊界均有固定 source ref。
- **pass**：原始三個唯讀 probe 有記錄輸出，分別覆蓋 repository structure、ADR 檔名與 ADR 狀態行。
- **pass（2026-09-19 重審）**：`make verify` exit `0`；兩套 typecheck 通過，unit 103 files／
  1223 tests、admin 32 files／350 tests、integration 107 files／902 tests 全數通過。
- **fail（當時預期的 discovery 結果）**：Doctor 因缺 `AGENTS.md`、`specs/stories/`、`Makefile`
  回 `STRUCTURE_INCOMPLETE`；後續採用工作已補齊這個結構。
- **not run**：沒有在 discovery 執行會寫入 target repo 的 `bootstrap`，也沒有深評選用
  `guidance/`；兩者都不是判斷整合層次所必需。
- **受影響檔案**：`docs/research/91-forgeflow-protocol-adoption.md` 與
  `docs/tickets/91-forgeflowv2-integration-discovery.md`；StoreWeave runtime diff 維持為零。
- **剩餘風險**：這是釘在 2026-09-09 `cb4bc97`／v0.7.0 的歷史調查；上游後來改名與演進的
  現況見 ADR 0051，不能從本文推定當前 CLI 契約。CI、merge policy 與人工 review 也不在
  Doctor 或本次文件核對的證明範圍。

## 審查觸發判定

工單 91 要求「涉及公開 API、授權、資料或 Extension isolation 的方案由 Sol/high 獨立審查」。
**依目前證據這條不觸發**：ForgeFlow 的 portability boundary 明文不需要 runtime、服務、排程器、
資料庫；採用只新增三個文件層的檔案，不觸及 StoreWeave 的公開 API、授權模型、資料或
Extension 隔離。此判定記在這裡供推翻。

## 沒有查的

- `protocol/handoff.md` 與 `protocol/versioning.md` 只掃過標題，沒有逐條讀——前者是跨 session
  交接格式，後者是 ForgeFlow 自己的版本相容政策，兩者都不影響「要不要採用」的判斷。
- `guidance/` 那套選配的工程指引與 `skills/` 目錄沒有評估，它們是採用之後的選項。
- 沒有跑 `./scripts/bootstrap`——它會寫入檔案，屬於後續 Story 而不是本票（本票 runtime diff 為零）。
