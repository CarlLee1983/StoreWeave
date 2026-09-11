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
| 交付形式 | 128 個 `.md`、17 個 `.sh`、2 個 `.ts`、2 個 `.go`；**沒有 `package.json`**、沒有可安裝套件 | `git ls-files` |
| 契約 | story／verification／execution／architecture／lifecycle／handoff／repository-contract／versioning 八份 | `protocol/` |
| 工具 | `bootstrap`、`doctor`、`story-check`、`verification-check`、`handoff-check`、`release-check`、`codex-activate` 七支 shell script | `scripts/` |
| 授權 | MIT | `LICENSE` |

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
| `docs/adr/*.md`（48 篇，帶 `Falsified if`） | `specs/decisions/ADR-<digits>-<slug>.md`，可用 `FORGEFLOW_DECISIONS_ROOT` 指到既有目錄 | **部分可用**，兩處格式要改 |
| `docs/specs/0001-0010` | 無對應概念；Story 之上沒有規格層 | 共存，不衝突 |
| `package.json` scripts（`typecheck`／`typecheck:admin`／`test`／`test:admin`／`test:integration`／`test:all`） | `make verify` 背後的實作 | **直接沿用**，包一層即可 |
| `.github/workflows/ci.yml`（typecheck+unit／integration ×2 shard／smoke docker／smoke native） | CI 應改呼叫 `make verify` 而非維護第二份定義 | 可沿用，但要決定哪幾支進 verify |
| 根目錄無 `AGENTS.md` | 必要檔案 | **缺** |
| 根目錄無 `Makefile` | 必要檔案 | **缺** |

### `make verify` 補的是一個真實缺口

StoreWeave 今天**沒有任何一個指令代表「做完了」**。完成條件散在 `ci.yml` 的兩個 job、
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

**缺口恰好三個，全部是新增檔案，沒有一項要求改動既有程式碼。** Doctor 的 static 模式明文
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

**所以引用既有 ADR 的完整代價被隔離出來了：48 篇各改一次檔名、各加一行英文狀態行。**
沒有其他隱藏成本。

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

採用的全部足跡是三個新增檔案（`AGENTS.md`、`Makefile`、`specs/stories/`）加選配的
`guidance/`。**沒有 dependency、沒有 migration、沒有設定、沒有 runtime 變更**，
rollback 就是刪掉這幾個檔案並把 CI 改回直接呼叫 pnpm scripts。ForgeFlow 本身以
bootstrap 複製檔案進來，不是套件相依，所以也沒有版本升級會破壞 build 的風險。

## 待決策事項

1. **`make verify` 背後放哪幾支？** 全部（含 integration 與兩支 smoke）會讓 verify 跑十幾分鐘，
   本地每次都跑不現實；只放 typecheck + unit 則 PASS 的意義弱於現在的 CI。
   協定允許用 risk profile 分層（`low` 不含 integration），但那要求每張 Story 宣告 risk。
2. **ADR 要不要改名對齊？** 代價已量化（48 篇檔名 + 一行狀態行）。不改的話 Story 就不能用
   `Decision:` 引用既有決策，架構那一層的追溯性等於放棄。
3. **`Falsified if` 與 ForgeFlow 的 decision 格式如何共存？** StoreWeave 的 ADR 紀律比
   ForgeFlow 要求的多一層（可證偽條件 + 它指名的邊界檔案清單，見
   `~/.claude/rules/decision-records.md`）。ForgeFlow 不禁止，但也不認得，需要決定是否
   讓它進 `make verify`。
4. **Authority 宣告與現行習慣的落差。** ForgeFlow 預設 `commit: no`／`push: no`，要在 Story
   裡逐項授權。StoreWeave 目前的做法是工單完成後直接 commit，這會變成每張 Story 都要宣告。
5. **既有工單與新 Story 的入口如何並存？** `docs/tickets/README.md` 是現在的派工入口，
   採用之後要說清楚「新工作看 `specs/stories/`，歷史看 `docs/tickets/`」。

## 下一份 spec 的範圍

建議拆成**兩張獨立實作票**，不要合成一張：

- **票 A（驗證基礎）**：新增 `Makefile` 露出 `verify`、新增根目錄 `AGENTS.md`、`ci.yml` 改呼叫
  `make verify`。不碰 Story 格式、不碰 ADR。驗收就是 Doctor 從 `STRUCTURE_INCOMPLETE`
  變成結構完整，且 CI 行為與現在等價。
- **票 B（Story 試點）**：用 Story 格式跑 B14 的第一張真工作，跑完回頭評估上面的待決策事項。

分開的理由是失敗歸因：票 A 失敗只是 Makefile 寫錯，票 B 失敗是流程不合身；混在一起就分不出
是哪一個。

## 審查觸發判定

工單 91 要求「涉及公開 API、授權、資料或 Extension isolation 的方案由 Sol/high 獨立審查」。
**依目前證據這條不觸發**：ForgeFlow 的 portability boundary 明文不需要 runtime、服務、排程器、
資料庫；採用只新增三個文件層的檔案，不觸及 StoreWeave 的公開 API、授權模型、資料或
Extension 隔離。此判定記在這裡供推翻。

## 沒有查的

- `protocol/handoff.md` 與 `protocol/versioning.md` 只掃過標題，沒有逐條讀——前者是跨 session
  交接格式，後者是 ForgeFlow 自己的版本相容政策，兩者都不影響「要不要採用」的判斷。
- `guidance/` 那套選配的工程指引與 `skills/` 目錄沒有評估，它們是採用之後的選項。
- 沒有跑 `./scripts/bootstrap`——它會寫入檔案，屬於實作票而不是本票（本票 runtime diff 為零）。
