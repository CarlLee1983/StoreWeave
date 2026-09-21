# Acceptance Criteria

## Happy Path

* [x] AC-001: A caller transaction can obtain the narrow Quote facts for an active Room Type while Property and Room Type rows remain locked until that transaction ends.

## Business Rules

* [x] AC-002: Property is locked before Room Type, and the returned facts contain the current Property currency, timezone, check-in time, cancellation window, and Room Type occupancy/stay limits.
* [x] AC-003: The capability performs no writes, owns no Availability or Reservation tables, and does not commit the caller's transaction.

## Failure Cases

* [x] AC-004: Invalid UUID fails before database access; missing Property and missing/inactive Room Type return the documented errors without exposing table access to consumers.

## Regression Requirements

* [x] AC-005: Existing Property reads, commands, and module composition continue to use the same `booking.property.read.v1` binding.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | PostgreSQL integration | `tests/integration/booking-property.test.ts` (5 tests) | a transaction locks Room Type; the capability then runs in a second transaction | capability waits on Room Type and a third Property update waits on the capability transaction until commit |
| `AC-002` | PostgreSQL integration | same test's narrow DTO assertion and blocker chain | populated Property and Room Type facts | returned values match owner facts; blocker chain demonstrates Property is locked before waiting on Room Type |
| `AC-003` | architecture/integration | `tests/architecture/booking-property-boundaries.test.ts` and same PostgreSQL test | successful caller transaction and source boundary | no Availability/Reservation ownership; caller controls transaction end and the capability only returns facts |
| `AC-004` | PostgreSQL integration | `tests/integration/booking-property.test.ts` | malformed UUID, no Property, missing and inactive Room Type | validation, conflict, and not-found errors are returned without writes |
| `AC-005` | typecheck/integration | existing Booking Property and Availability module-composition tests | existing read binding | all existing consumers still compose through the same capability id |

## Verification

* `pnpm exec vitest run --project integration tests/integration/booking-property.test.ts` — 1 file / 5 tests passed, including Property-before-Room-Type lock ordering and caller-held row locks.
* Independent Sol/high review: PASS after resolving the initial DTO immutability and lock-lifetime evidence findings.
* Full `make verify` — passed: typecheck and admin typecheck; unit 134 files / 1,410 tests; admin 32 files / 351 tests; integration 110 files / 923 tests.
