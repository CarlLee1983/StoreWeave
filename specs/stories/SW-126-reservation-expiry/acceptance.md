# Acceptance Criteria

## Happy Path

* [x] AC-001: An overdue pending-payment Reservation becomes `expired` and releases all its Room Nights atomically.

## Business Rules

* [x] AC-002: Confirmed, cancelled, and non-overdue Reservations remain unchanged.
* [x] AC-003: Expiry is idempotent and a renewed deadline prevents stale-job release.

## Failure Cases

* [x] AC-004: A failed release transaction leaves neither a partial expiry nor supply drift.

## Regression Requirements

* [x] AC-005: Expiry does not add Payment Attempt or notification ownership.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | real PostgreSQL worker/job test with Worker host clock behind PostgreSQL | expired pending Reservation | state and all releases commit |
| `AC-002` | integration | state/deadline matrix | non-expirable fixtures | no-op |
| `AC-003` | integration | duplicate expiry and renewed-deadline stale work | stale scheduled work | no double release |
| `AC-004` | integration | injected release failure after the Availability decrement | transactional fixture | state, supply, audit, and command idempotency roll back |
| `AC-005` | architecture | reservation package scan | completed change | no Payment Attempt or notification ownership |
