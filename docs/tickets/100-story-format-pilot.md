# 100 — 用一張真工作試 Story 格式

**What to build:** 拿 B14 的第一張真工作當試點，照 ForgeFlow 的 Story 格式寫一遍、走完一次生命週期，然後回答「這套流程適不適合 StoreWeave」。不是寫一張示範用的空 Story——示範不會暴露不合身的地方。

**Blocked by:** 99

**Status:** blocked（等 B14 的第一張工作確定是什麼）

- [ ] 新增 `specs/stories/`，用 `SW-<digits>` 這種 ID（實測 `SW-1` 通過文法；既有的裸數字檔名全部不合格）
- [ ] B14 第一張工作寫成 `story.md` + `acceptance.md`，`scripts/story-check --ready` 回 `STORY_CONTRACT_OK`
- [ ] 走完 `READY → IMPLEMENTING → VERIFYING → REVIEW`，`make verify` 通過
- [ ] 記錄 `verification.md`，每一條 acceptance criterion 都有 passing evidence；`scripts/verification-check --result` 回 `VERIFICATION_PASS`
- [ ] Doctor 回 `STRUCTURE_OK`
- [ ] 跑完回報四件事：哪裡比現在的工單好、哪裡更糟、`Authority` 逐項宣告的實際摩擦、以及既有工單與新 Story 兩個入口怎麼並存

## 跑完之後要決定的

[discovery](../research/91-forgeflow-protocol-adoption.md) 列的五項待決策，跑完這一張才有依據回答其中三項：

- **ADR 要不要改名對齊。** 代價已量化：48 篇各改一次檔名、各加一行 `* Status:`。不改的話
  Story 就不能用 `Decision:` 引用既有決策，架構那一層的追溯性等於放棄。
- **`Falsified if` 怎麼共存。** StoreWeave 的 ADR 紀律比 ForgeFlow 要求的多一層——可證偽條件
  加它指名的邊界檔案清單。ForgeFlow 不禁止也不認得，要決定它進不進 `make verify`。
- **既有工單與新 Story 的入口。** `docs/tickets/README.md` 是現在的派工入口，採用之後要說清楚
  「新工作看 `specs/stories/`，歷史看 `docs/tickets/`」。

## 明確不做的

**既有 01–99 一張都不轉換。** 那些票承載的是被推翻的做法、code review 擋下什麼、
為什麼這個預設值是這個數字——`story.md` 沒有欄位放這些。它們的價值在於「以後有人問為什麼」
時讀得到，不在於能被 `story-check` 解析。轉換是純成本，讀者是零。

## 邊界

與工單 99 分開是為了失敗歸因：99 失敗只是 Makefile 寫錯，100 失敗是流程不合身。
合成一張就分不出是哪一個。
