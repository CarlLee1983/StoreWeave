# Acceptance Criteria

## Happy Path

* [ ] AC-001: A required full refund is recorded, sent through a refund-capable Provider, and reaches a durable terminal result.

## Business Rules

* [ ] AC-002: Late/Excess refunds equal received amount and retries are idempotent.
* [ ] AC-003: Failed refunds remain operator-visible and do not revive Reservation or Room Night state.

## Failure Cases

* [ ] AC-004: Over-refund, currency mismatch, duplicate completion, and unsupported Provider requests are rejected.

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
