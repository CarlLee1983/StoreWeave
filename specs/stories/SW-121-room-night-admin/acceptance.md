# Acceptance Criteria

## Happy Path

* [x] AC-001: Operators can set Availability-owned Room Type base nightly price, daily sellable units, and an optional local-date nightly-price override.

## Business Rules

* [x] AC-002: Each Room Night is unique and uses the Property-local date.
* [x] AC-003: Updating supply cannot put sellable units below reserved units; absent local-date overrides use the Availability-owned Room Type base nightly price.

## Failure Cases

* [x] AC-004: Invalid ranges, values, or Room Types leave no partial daily updates.

## Regression Requirements

* [x] AC-005: This administration boundary does not own Quote, Reservation, or Admin shell behavior and has no cross-module foreign key.
* [x] AC-006: The Availability package resolves through the root TypeScript alias, frozen workspace lockfile, and Docker builder manifest.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `tests/integration/booking-availability.test.ts` | active Room Type with configured base price | base price, daily supply, and overrides persist and read back |
| `AC-002` | integration | `tests/integration/booking-availability.test.ts` | repeat and overlapping half-open local-date ranges | one Room Night per `(room_type_id, local_date)` under concurrent updates; returned dates remain Property-local |
| `AC-003` | integration | `tests/integration/booking-availability.test.ts` | reserved-unit fixture | unsafe reduction rejected; absent override selects base price |
| `AC-004` | integration | `tests/integration/booking-availability.test.ts` | malformed/overlong range, negative value, inactive/unknown Room Type, and blocked date in a batch | transaction leaves every target date unchanged |
| `AC-005` | architecture | `tests/architecture/booking-availability-boundaries.test.ts` | completed module package | owns only Availability tables; no Quote, Reservation, Admin shell, Commerce, or cross-module FK |
| `AC-006` | command/architecture | frozen lockfile install; `tests/unit/dockerfile-workspaces.test.ts`; package alias resolution assertion | root workspace registration | TypeScript resolves the package; Docker and lockfile include its manifest |

## Completion Verification

* `pnpm install --lockfile-only --frozen-lockfile --ignore-scripts` passed; 658 lockfile entries were validated.
* `make verify` passed: backend and Admin typechecks; unit 126 files / 1,372 tests; Admin 32 files / 351 tests; integration 109 files / 915 tests, including all 5 Availability integration tests.
* Independent Sol/high design analysis and review passed; the single pg client concurrency finding was fixed and its regression coverage passed.
* `git diff --check` passed.
