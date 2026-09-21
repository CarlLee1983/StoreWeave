# Acceptance Criteria

## Happy Path

* [x] AC-001: A current valid Quote creates one `pending_payment` Reservation with the default 15-minute payment deadline and occupies every requested Room Night.

## Business Rules

* [x] AC-002: The Reservation freezes nightly prices, currency, total, and Cancellation Policy, including totals above PostgreSQL's 32-bit integer range.
* [x] AC-003: A stale price/policy Quote returns a replacement Quote; unavailable supply creates neither Reservation nor hold.

## Failure Cases

* [x] AC-004: Invalid Booker/Guest, dates, room count, or occupancy is rejected with no durable partial state.

## Regression Requirements

* [x] AC-005: Reservation uses the Availability capability and does not own Room Night tables or Commerce concepts; idempotency replay and audit evidence contain no Booker contact data.

## Workspace Registration

* [x] AC-006: The Reservation package resolves through the root TypeScript alias, is included in the Docker build dependency layer, has a pnpm lockfile importer, and the B17 semantic ledger and SW-102 baseline fingerprints match the resulting lockfile-derived artifacts.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | PostgreSQL command/Availability test | current Quote and available nights | Reservation has 15-minute default deadline; all holds commit together |
| `AC-002` | integration | frozen-term and large-total query tests | created Reservation; total above 2,147,483,647 minor units | future source changes do not alter snapshot; the full safe-integer Quote total persists |
| `AC-003` | integration | `tests/integration/booking-reservation.test.ts` and Availability quote-reservation integration | changed price at the Reservation command; changed price/policy at the Availability capability; sold-out night | replacement or unavailable result; no Reservation or partial hold |
| `AC-004` | integration | malformed input tests | invalid creation fixtures | no Reservation or reserved drift |
| `AC-005` | architecture | package dependency scan | completed module | capability-only Availability use |
| `AC-005` | integration | command idempotency and audit rows | successful and replayed create | same reservation result; no Booker name, email, or phone in response replay or audit payload |
| `AC-006` | architecture | root alias/build/lock registration test | registered workspace package | alias resolves to public entrypoint and Dockerfile/lockfile include the package |
| `AC-006` | derived artifact | `docs/base/b17/commerce-public-contract.semantic.v2.json` | updated lockfile | semantic ledger dependency-lock SHA matches `pnpm-lock.yaml`; Commerce contract surfaces remain unchanged |
| `AC-006` | derived artifact | `tests/architecture/fixtures/sw-102-release-baseline.v1.json` | refreshed B17 semantic ledger | SW-102 public-contract input SHA matches the changed B17 artifact |

## Review and Verification

* Sol/high design review accepted the versioned `booking.availability.quote-reservation.v1` seam. The command calls it inside `CommandContext.tx` and inserts Reservation before that transaction commits, so insert failure rolls the room-night reservation back.
* Independent Sol/high implementation review: PASS with no material findings. Delta review also passed after `total_minor` moved to PostgreSQL `bigint` and the 4,000,000,000-minor-unit regression case was added.
* Full `make verify` passed on 2026-09-22: backend TypeScript check, Admin TypeScript checks, unit 136 files / 1,414 tests, Admin 32 files / 351 tests, and integration 111 files / 924 tests.
* The lockfile importer changed two derived Commerce evidence hashes only: the B17 semantic ledger lockfile fingerprint and SW-102's recorded input fingerprint. Commerce contract surfaces and Base/Commerce build graphs stayed unchanged.
