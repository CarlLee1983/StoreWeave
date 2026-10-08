# Acceptance Criteria

## Snapshot and atomicity

* [x] AC-001 / ORD-02: Catalog name and price changes leave the existing order line name, unit price, and total unchanged.
* [x] AC-002 / ORD-06: A multi-line checkout with insufficient stock on one line creates no order and changes no stock availability.

## Reservation and concurrency

* [x] AC-003 / ORD-07: Reserving all available stock causes the next buyer's checkout to be rejected.
* [x] AC-004 / ORD-08: Two concurrent buyers of the last unit produce exactly one order and one reservation.
* [x] AC-005 / ORD-09: Concurrent multi-line checkouts stay within stock bounds; losers leave neither orders nor reservations.

## Replay

* [x] AC-006 / ORD-10: Replaying the same checkout after another buyer consumes remaining stock returns the original order without another reservation.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| AC-001 | integration test | `tests/integration/order-existing-conformance.test.ts` ORD-02 | Stored line snapshot and total retain checkout values |
| AC-002 | integration test | same file, ORD-06 | No order; both stock rows retain original availability |
| AC-003 | integration test | same file, ORD-07 | Second buyer receives `VALIDATION_ERROR`; stock stays fully reserved |
| AC-004 | integration test | same file, ORD-08 | One success, one `VALIDATION_ERROR`, one stored order and reservation |
| AC-005 | integration test | same file, ORD-09 | Winners fit both stock rows; loser has no order; available equals on hand less reserved |
| AC-006 | integration test | same file, ORD-10 | Original order ID replays after remaining stock is consumed |
