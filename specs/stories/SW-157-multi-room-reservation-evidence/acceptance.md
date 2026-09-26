# Acceptance Criteria

* [x] AC-001: A valid two-room, multi-night Reservation with adults and children persists with exact occupancy and increments each Room Night by two.
* [x] AC-002: Too few adults and excess occupants return validation errors before Room Night locking; neither creates a Reservation nor changes inventory.
* [x] AC-003: Insufficient units on a later night reject the entire creation without a partial Reservation or inventory drift.
* [x] AC-004: Two real PostgreSQL contenders for the final two units produce one Reservation and one recognizable unavailable result; blocking and exact nightly counts are asserted.
* [x] AC-005: Focused integration checks, independent review and `make verify` pass; SW-146 records the command, candidate identity and result.

## Evidence

`tests/integration/booking-reservation.test.ts` adds four `SW-157 multi-room Reservation` cases against the real Reservation command and PostgreSQL Room Night rows:

| AC | Observed evidence |
| --- | --- |
| AC-001 | Two adults and two children occupy two rooms for two nights; the persisted Reservation stores occupancy, dates, total, nightly prices, policy and Quote fingerprint, while both Room Nights move from 0 to 2 reserved units. |
| AC-002 | A separate transaction holds both Room Night row locks while each invalid Reservation command returns `VALIDATION_ERROR`; Reservation count and both Room Night rows remain unchanged before and after releasing the locks. |
| AC-003 | First night has two units and later night one; creation returns `unavailable`, with zero Reservation rows and unchanged per-night inventory. |
| AC-004 | Two commands queue behind a held PostgreSQL Room Night lock; `pg_blocking_pids` shows both blocked before release. Results are exactly `created` and `unavailable`, with one persisted Reservation and exactly two reserved units on each night. |

Focused check: `pnpm exec vitest run --project integration tests/integration/booking-reservation.test.ts -t SW-157` — 4 passed, 62 skipped. `pnpm typecheck` passed. Sol/high independent review was clean on 2026-09-26. The full `make verify` passed at SW-146 checkpoint 4 (unchanged source digest recorded there), including all 66 Booking Reservation integration tests. GitHub #110 remains remotely open; no issue closure was authorized or performed.
