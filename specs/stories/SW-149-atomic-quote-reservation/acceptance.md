# Acceptance Criteria

## Happy Path

* [x] AC-001: A current authenticated Quote with sufficient supply reserves every requested night atomically and returns the exact Quote terms.

## Business Rules

* [x] AC-002: Property and Room Type facts, base price, and Room Nights are locked in the documented fixed order; concurrent quote-affecting writes cannot slip between revalidation and reservation.
* [x] AC-003: A valid retired signing key remains acceptable while configured, and successful/replacement Quotes use the active key.
* [x] AC-004: `stale` returns a current replacement Quote for changed, tampered, unknown-key, or removed-key fingerprints with valid syntax and reserves nothing.
* [x] AC-005: Insufficient supply returns `unavailable` with no partial reserved-unit change; caller rollback restores all increments after a reserved result.

## Failure Cases

* [x] AC-006: Caller-only validation and fingerprint format fail before I/O; Property-local horizon and Room Type stay/occupancy checks run after locked Property reads but before Availability-row reads or locks.
* [x] AC-007: Existing quote room-count limits remain required configuration; no fallback/default cap is introduced.

## Regression Requirements

* [x] AC-008: Availability owns all Availability table reads and writes; the capability accepts only a caller-owned transaction and does not write Reservation data or commit.
* [x] AC-009: Real PostgreSQL concurrency proves there is no double allocation, partial range reservation, or stale-price/policy reservation.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | PostgreSQL integration | `tests/integration/booking-availability-quote-reservation.test.ts` (6 tests) | matching fingerprint and available multi-night supply, then caller rollback | exact current Quote returned; both nights reserve together and rollback restores counts |
| `AC-002` | source/integration | `quote-reservation.ts`, SW-148 Property lock test, and atomic concurrent writer test | Property, Room Type, base price, and Room Nights updated under contention | source locks in fixed order; policy/base-price writers block until atomic caller ends |
| `AC-003` | PostgreSQL integration | configured retired-key case in the same integration file | Quote signed by retired key while both retired and active keys remain configured | reservation succeeds and returned Quote uses active key |
| `AC-004` | PostgreSQL integration | changed-price, changed-policy, tampered MAC, and unknown-key cases | prior fingerprint remains syntactically valid | replacement Quote returned with unchanged supply |
| `AC-005` | PostgreSQL integration | one-night unavailable and two contenders for final supply | multi-night request with one night at zero supply; then concurrent requests | unavailable takes precedence, no partial count changes; exactly one final-unit reservation succeeds |
| `AC-006` | PostgreSQL integration | malformed-fingerprint, configured cap, and invalid-owner-facts cases | bad syntax, over-cap request, and locked facts with occupancy mismatch | caller failures avoid Property reads; owner mismatch avoids Availability base-price access |
| `AC-007` | unit/module contract | `packages/booking/availability/test/quote-reservation.test.ts` and module/binder usage | valid and invalid explicit room-count cap | cap is required and invalid configuration fails; no default is introduced |
| `AC-008` | architecture | `tests/architecture/booking-availability-boundaries.test.ts` | Availability module and source graph | versioned capability is declared/bound; no foreign table access, Reservation writes, or commit |
| `AC-009` | PostgreSQL concurrency | final-unit and concurrent Property/base-price writer cases | overlapping quote-reserve and update transactions | no double allocation; changes serialize after exact-match reserve without deadlock |

## Verification

* `pnpm typecheck` — passed.
* Focused Availability Quote/page/boundary unit checks — 3 files / 15 tests passed; Quote reservation contract — 1 file / 1 test passed.
* Focused PostgreSQL integration: `tests/integration/booking-availability-quote-reservation.test.ts` — 1 file / 6 tests passed, including key rotation, stale terms, rollback, and concurrency.
* Independent Sol/high review — PASS, no material findings.
* Full `make verify` — passed: typecheck and admin typecheck; unit 134 files / 1,410 tests; admin 32 files / 351 tests; integration 110 files / 923 tests.
