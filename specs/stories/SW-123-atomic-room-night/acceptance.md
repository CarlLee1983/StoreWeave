# Acceptance Criteria

## Happy Path

* [x] AC-001: The versioned supply-only capability reserves or releases every requested Room Night within the caller's transaction; an outer rollback restores all counts.

## Business Rules

* [x] AC-002: Missing nights are materialized and all rows are locked in ascending local-date order; competing multi-night materialization and overlapping writes remain deadlock-free, and no night may exceed sellable units.
* [x] AC-003: Partial availability changes no reserved counts; release preflights the entire range and never underflows or partially decrements.

## Failure Cases

* [x] AC-004: Two concurrent attempts for the final unit yield exactly one success and one recognizable unavailable result.

## Regression Requirements

* [x] AC-005: The capability exposes only supply operations, takes the caller's transaction, retains Property-local dates, and owns no Quote, Reservation, or payment behavior.

## Input Validation

* [x] AC-006: Invalid UUID, canonical dates, half-open ranges, 1–30-night stay length, positive safe room count, and clock are rejected before database access.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `packages/booking/availability/test/room-night-operations.integration.test.ts` | multi-night available range and caller rollback | reserve/release are atomic and an outer rollback restores counts; passed |
| `AC-002` | integration/unit | `room-night-operations.integration.test.ts` and `room-night-operations.test.ts` | missing nights, concurrent reserve/release/admin writes, and two writers materializing the same missing range | blocker observations prove contention, operations complete without deadlock, rows are unique and ordered, and final counts match the serialized result; passed |
| `AC-003` | integration/unit | `room-night-operations.integration.test.ts` and `room-night-operations.test.ts` | one unavailable night; missing or underflowing release | no reserved count changes on failure; passed |
| `AC-004` | integration | real concurrent final-unit test in `room-night-operations.integration.test.ts` | two transactions | exactly one succeeds, the other is unavailable, and the first retains locks until commit; passed |
| `AC-005` | unit/architecture | `packages/booking/availability/test/room-night-operations.test.ts` and `tests/architecture/booking-availability-boundaries.test.ts` | module and capability sources | stable supply-only capability; no Reservation, Quote fingerprint, payment, or foreign-table imports; passed |
| `AC-006` | unit | `packages/booking/availability/test/room-night-operations.test.ts` | malformed UUID, dates, range, counts, and invalid clock | validation fails before repository calls; passed |

## Verification

* `pnpm typecheck`: passed.
* `pnpm exec vitest run --project unit packages/booking/availability/test/room-night-operations.test.ts packages/booking/availability/test/room-night-operations.integration.test.ts tests/architecture/booking-availability-boundaries.test.ts`: 3 files, 17 tests passed.
* `make verify`: passed on 2026-09-21; unit 130 files / 1,394 tests, admin 32 files / 351 tests, integration 109 files / 915 tests.
* The first full gate had one non-reproducible failure in the unrelated paired CLI upgrade test. Its isolated rerun passed, followed by the complete passing gate above.
