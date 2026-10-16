---
title: "真實 Codex smoke 沒授權額度就標 NOT RUN"
author: Carl
date: 2026-10-16
standing: true
---

## Decided
The real Codex smoke test is opt-in. Don't start real Codex or spend model quota unless the user explicitly authorizes it for that task.
Finish all the offline work first. Report the smoke as `NOT RUN`, with the reason: no explicit quota authorization.
Never write it up as PASS. Never describe it as acceptance of recovery or long-running reliability.

## Watch out
If the code changes after a real smoke run, the tested SHA and the PR head SHA diverge. Record them separately.

_Told to Claude in 2 past sessions here, most recently on Sep 15._
