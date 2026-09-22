# Acceptance Criteria

## Happy Path

* [x] AC-001: An authorized Booker before deadline cancels the whole Reservation, releases all Room Nights, and creates a full-refund request.

## Business Rules

* [x] AC-002: Operator cancellation records reason and permits only zero through actual received refund amount.
* [x] AC-003: Cancellation/release are atomic; refund failure leaves Reservation cancelled and visible for retry.

## Failure Cases

* [x] AC-004: Late/unauthorized self-service, partial change, invalid state, missing reason, and invalid refund are rejected without drift.

## Regression Requirements

* [x] AC-005: Dates, Room Type, and room count remain immutable; no partial cancellation is added.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | self-cancel transaction test | pre-deadline paid Reservation | cancelled/released/refund work |
| `AC-002` | integration | operator-cancel amount/reason test | operator fixture | bounded amount and audit |
| `AC-003` | integration | refund failure test | failing refund worker | cancelled state persists |
| `AC-004` | integration | cancellation error matrix | invalid fixtures | no state/count change |
| `AC-005` | regression | Reservation mutation tests | created Reservation | immutable fields remain protected |
