# Acceptance Criteria

## Happy Path

* [ ] AC-001: A verification record maps every Spec 0011 §9 condition to executable evidence or an explicitly separate external release gate.
* [ ] AC-002: `make verify` passes at the recorded source revision after all Booking stories are integrated.

## Business Rules

* [ ] AC-003: Evidence records command, result, revision, and artifact/test location; focused checks do not substitute for `make verify`.
* [ ] AC-004: ECPay staging refund UAT, real SMTP, production config/deployment, and operator acceptance stay visibly unresolved unless separately evidenced.

## Failure Cases

* [ ] AC-005: Missing/stale evidence, failed verification, unavailable Docker/testcontainers, or mock substitution for an external gate blocks completion and is recorded.

## Regression Requirements

* [ ] AC-006: Verification is read-only and does not alter source to manufacture a passing result.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | documentation review | §9-to-evidence matrix | completed Booking checks | every condition has check or named gate |
| `AC-002` | command | `make verify` | Docker/testcontainers available | exit 0 at recorded revision |
| `AC-003` | record review | verification log | completed command outputs | command/result/revision/location present |
| `AC-004` | documentation review | release-gate section | no external approval assumed | gates remain explicit and unpassed |
| `AC-005` | negative record review | failed/missing-environment sample | induced/missing evidence | completion blocked with reason |
| `AC-006` | diff review | verification changes | final worktree | docs/tests evidence only; no source workaround |
