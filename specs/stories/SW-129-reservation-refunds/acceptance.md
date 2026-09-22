# Acceptance Criteria

## Happy Path

* [x] AC-001: A required full refund is recorded, sent through a refund-capable Provider, and reaches a durable terminal result.

## Business Rules

* [x] AC-002: Late/Excess refunds equal received amount and retries are idempotent.
* [x] AC-003: Failed refunds remain operator-visible and do not revive Reservation or Room Night state.

## Failure Cases

* [x] AC-004: Over-refund, currency mismatch, duplicate completion, and unsupported Provider requests are rejected.

## Regression Requirements

* [ ] AC-005: ECPay staging refund UAT remains an external Booking release gate.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | refund workflow test | refundable recorded payment | durable request and result |
| `AC-002` | integration | late/excess/retry test | received-payment fixtures | exact amount and one effect |
| `AC-003` | integration | Provider failure/retry test | failing provider | visible failure; Reservation unchanged |
| `AC-004` | integration | invalid refund matrix | invalid amounts/currency/provider | recognizable rejection |
| `AC-005` | review | release-gate record | ECPay provider selection | UAT remains explicitly pending |

## Review and Verification Evidence

* Focused architecture boundary test — passed (4 tests): Reservation owns the refund header and immutable invocation tables, registers the worker, rejects a mismatched Provider before invocation, and does not cross into Commerce payment/refund modules.
* Focused integration fixtures — passed: a verified callback replay with a distinct idempotency key creates one Excess header; a failed transport retry's generation two call uses exactly the same provider request reference; a configured-provider mismatch records terminal `indeterminate` evidence before dead-lettering without adapter invocation; cancellation seam fixtures keep zero/full/partial amounts exact and reject zero or a changed amount after positive evidence exists.
* Invalid-request matrix — passed: over-refund and stored-currency mismatch are rejected, a duplicate completed refund request conflicts, and an `unsupported` Provider result is persisted as a durable failed Refund without changing its confirmed Reservation.
* Focused migration upgrade fixture — passed: an SW-128 (`0001`–`0008`) database with a real winning Attempt plus a distinct Excess Attempt upgrades through `0009` and `0010`, deterministically backfills late/excess headers without direct `platform_jobs` writes, then the public runtime reconciliation command queues the provider work.
* Reconciliation recovery fixture — passed: `replaceExisting` uses runtime queue semantics to make the oldest dead pending-refund occurrence runnable again, and after it becomes terminal a batch larger than 100 reaches the previously unscheduled later Refund.
* Database integrity fixture — passed: the composite Refund `(payment_attempt_id, reservation_id)` foreign key rejects a cross-Reservation direct insert.
* `pnpm typecheck` — passed after the refund slice.
* AC-005 remains an external release gate: no ECPay merchant enablement or staging UAT is claimed by this package work.
