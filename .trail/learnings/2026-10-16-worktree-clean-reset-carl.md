---
title: "用獨立 worktree 與新分支工作，不 clean、不 reset"
author: Carl
date: 2026-10-16
standing: true
---

## Decided
For each task, fetch `origin/main` and record the baseline SHA. Create a new branch in a separate worktree from that SHA.
Never run `git clean` or `reset --hard`. Never overwrite the user's uncommitted changes. Don't delete existing evidence directories or `graft/`.
If `main` has moved past the baseline the task named, re-check that the problem still exists. Don't revert to the old version.

_Told to Claude in 4 past sessions here, most recently on Sep 15._
