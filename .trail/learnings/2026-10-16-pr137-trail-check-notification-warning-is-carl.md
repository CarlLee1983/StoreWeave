---
title: PR137 trail check notification warning is a reviewed false positive
author: Carl
date: 2026-10-16
branch: fix/pr137-integration
touches:
  - tests/integration/booking-reservation.test.ts
---

## Decided
The PR137 change retains existing failed notification fixtures and adds only a test helper whose claim filter admits booking.reservation.anonymize-expired-pii for the selected Worker id. Notification jobs are not prohibited in this repository. The independent reviewer confirmed the implementation and the warning as a false positive.

## Tried and ruled out
Do not remove useful explanatory comments or weaken tests merely to silence a lexical learning conflict. No behavior change is warranted for this warning.

## Watch out
trail check currently flags the helper comment as bringing back job type notification, citing the diagnostic evidence paragraph of the earlier retention learning. That paragraph describes the cause; it does not ban the job type. If committing or opening a PR for this change, explain this reviewed conflict in the commit message or PR description. The code and four focused tests were reviewed clean; the full make verify run is tracked separately.
