---
title: Scope retention test workers to retention jobs in the shared Booking database
author: Carl
date: 2026-10-16
branch: fix/pr137-integration
touches:
  - tests/integration/booking-reservation.test.ts
---

## Decided
PR #137 CI failure in the hash-only checkout test came from the test helper draining all job types, while treating every failure as a retention failure. Keep retention-only assertions scoped using the existing JobQueue.claim type filter in a short-lived, worker-id-specific test spy, restored in finally. Keep real Worker execution, continuation jobs, and genuine retention failure checks. No production Worker API change is needed.

## Tried and ruled out
The isolated checkout test passed, while an unchanged full Booking test file reproduced `processed 2, failed 1: []`. A temporary diagnostic query including all job types plus making existing pending retries due identified platform.event.deliver with a late-payment notification idempotency payload conflict. The retention-only diagnostic query explained the empty array. Baseline make verify passed, so a single green suite run does not disprove this timing interaction. Do not fix it by swallowing worker failures, deleting earlier fixtures' evidence, or adding sleeps.

## Watch out
The Booking integration file intentionally shares a database and leaves retryable notification jobs. Scope both the initial retention batch and restart/continuation draining. Regression coverage should place an unrelated failing job explicitly due and assert it stays pending with zero attempts while retention completes; a malformed retention job must still reject with diagnostic evidence. Temporary diagnostic changes must be removed.
