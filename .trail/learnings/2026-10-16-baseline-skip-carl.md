---
title: "動工前先跑 baseline，不靠 skip 或放寬斷言取得綠燈"
author: Carl
date: 2026-10-16
standing: true
---

## Decided
Before changing code, run `make verify` and `go test -race -count=1 ./...`. Record existing failures and environment limits separately from failures your change causes.
Never skip a test, loosen an assertion, drop `-race`, or extend a timeout to get green. A past CI pass doesn't replace a run on the current code.

_Told to Claude in 3 past sessions here, most recently on Sep 14._
