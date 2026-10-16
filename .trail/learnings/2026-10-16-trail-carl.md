---
title: "評估 trail 成效的方法"
author: Carl
date: 2026-10-16
branch: main
cost: { minutes: 2, tokens: 47933 }
touches:
  - AGENTS.md
  - opencode.json
---

## Decided
- trail 於 2026-10-16 導入；導入前沒有任何 trail 使用紀錄，成效要靠之後的 session 對照基準來判斷。
- 基準：9 月中以前每個 session 有 60–170 次 shell grep/cat/sed，9 月下旬以後是 0–20 次（來源：~/.claude/projects/-Users-carl-Dev-Carl-StoreWeave/*.jsonl）。
- 指標：同類任務（一張 Story）的 grep/cat/Read 呼叫次數與 input tokens；trail ask 的第一名是否命中 commit diff 實際改動的檔案。

## Tried and ruled out
- 直接採用 trail 自報的「tokens saved」：它的基準是把命中的檔案整份讀完，會高估。拿 aec2500 測，它報省 83%，但實際的 pack（約 3.8k tok）比 rg 列出所有命中（約 2.5k tok）還大。

## Watch out
- ask 的排名準（aec2500 的第一名就是 seedOperations），但內嵌的是函式開頭，不是實際改動的那段；長函式還是要開檔讀確切的行範圍。
