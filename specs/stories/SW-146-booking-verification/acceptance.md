# Acceptance Criteria

## Happy Path

* [ ] AC-001: A verification record maps every Spec 0011 §9 condition to executable evidence or an explicitly separate external release gate.
* [x] AC-002: `make verify` passes at the recorded source revision after all Booking stories are integrated.

## Business Rules

* [x] AC-003: Evidence records command, result, revision, and artifact/test location; focused checks do not substitute for `make verify`.
* [x] AC-004: ECPay staging refund UAT, real SMTP, production config/deployment, and operator acceptance stay visibly unresolved unless separately evidenced.

## Failure Cases

* [x] AC-005: Missing/stale evidence, failed verification, unavailable Docker/testcontainers, or mock substitution for an external gate blocks completion and is recorded.

## Regression Requirements

* [x] AC-006: Verification is read-only and does not alter source to manufacture a passing result.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | documentation review | §9-to-evidence matrix | completed Booking checks | every condition has check or named gate |
| `AC-002` | command | `make verify` | Docker/testcontainers available | exit 0 at recorded revision |
| `AC-003` | record review | verification log | completed command outputs | command/result/revision/location present |
| `AC-004` | documentation review | release-gate section | no external approval assumed | gates remain explicit and unpassed |
| `AC-005` | negative record review | failed/missing-environment sample | induced/missing evidence | completion blocked with reason |
| `AC-006` | diff review | verification changes | final worktree | docs/tests evidence only; no source workaround |

## Current evidence

[verification.md](verification.md) records the §9.1–17 matrix, exact repository commands and test paths, application source SHA `d1e707e8342e7a1336d829dd17fe36c1cfcf142d`, initial evidence commit `16e435b1d9a77296df00be6c9019aa9a35fe5a3b`, explicit coverage limits, unresolved external gates, and the failure/missing-evidence rule. `AC-001` stays unchecked because §9.8 lacks direct callback/cancellation and callback/expiry race assertions (blocker #109), and §9.13 lacks a real PostgreSQL multi-room occupancy-plus-inventory Reservation case (blocker #110). The record also bounds aggregate §9.1 coverage, captured-log scope for §9.11, and Booking-selected Admin shell typing for §9.14. These gaps are not external gates.

`AC-002` and `AC-003` are supported by `make verify > /tmp/storeweave-sw146-make-verify.log 2>&1`, exit 0 on `2026-09-25 01:35 UTC` at the application source revision above with documentation-only PR head `16e435b1d9a77296df00be6c9019aa9a35fe5a3b`. The local log has SHA-256 `1c732435fe22361ff706b2338d37a92bc20d65bc91b9f062596dc36b71c72641` and records both typechecks plus 155/1,524 unit, 32/351 Admin, and 115/1,021 integration file/test counts. It is a temporary local artifact; [PR #108 Actions run 36081990094](https://github.com/CarlLee1983/StoreWeave/actions/runs/36081990094) is durable evidence of all 10 CI checks passing on that earlier documentation head. The current documentation-only delta is not in that CI head. `AC-006` is based on this worktree's documentation-only diff review and the clean PR worktree after the gate.
