# AGENTS.md

給在這個倉庫寫程式的 coding agent。人類的入口是 [README.md](README.md)。

## 完成的定義

`make verify` 通過才算做完。它跑後端與後台的型別檢查，加上 unit、admin、integration
三套測試；整合測試用 testcontainers 起 PostgreSQL，所以本機要有 Docker 在跑。

中途要快回饋就跑個別目標（`make test`、`make typecheck`），完成與否仍以 `make verify` 為準——
unit 全綠而 integration 抓到失敗的情況發生過，理由見[工單 99](docs/tickets/99-make-verify-and-agents-guide.md)。

`verify` 背後只放唯讀的檢查。驗證不能靠改寫原始碼換到綠燈。

## 工作範圍

工作來自 `specs/stories/` 的一張已核准 Story，做的就是那張 Story 上寫的事。
`docs/tickets/` 是歷史存檔，不再新增。
範圍外發現的問題交由 GitHub Issues 記錄，不夾帶進當前 Story。

改動過的行為要有測試。既有測試轉紅時預設是實作壞了，確認過測試本身寫錯才改測試。

工單的狀態與 checkbox 跟著程式碼走：實作落地就把它勾起來。

## 先讀哪裡

- 詞彙：根目錄 [CONTEXT.md](CONTEXT.md)。`Order`、`Session`、`Actor`、`Account` 這些字在這裡有精確定義，用它們的意思寫程式
- 決策與理由：[docs/adr/](docs/adr/)。動到模組邊界、公開介面或不變條件之前先讀，`- 狀態：proposed` 的是還沒定案的
- 架構全貌：[docs/architecture.md](docs/architecture.md)

Core 永遠不改：品牌差異走 Theme，特殊需求走 Extension。

## 這個倉庫的坑

- 套件管理器是 pnpm，版本釘在 `package.json` 的 `packageManager`
- `vitest.config.ts` 根層設了 `fileParallelism: false`，整合測試單支就要二十分鐘以上；`make verify` 放背景跑，前景會逾時
- `docs/tickets/README.md` 是一份長敘事史，不是索引；要改它得先找對段落

## Agent skills

### Issue tracker

問題回報與分流使用 StoreWeave 的 GitHub Issues；已核准的實作 Story 仍以 `specs/stories/` 為準。見 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Triage labels

分流使用五個預設標籤。見 [docs/agents/triage-labels.md](docs/agents/triage-labels.md)。

### Domain docs

使用單一根目錄脈絡：`CONTEXT.md` 與 `docs/adr/`。見 [docs/agents/domain.md](docs/agents/domain.md)。
