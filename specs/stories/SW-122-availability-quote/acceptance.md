# Acceptance Criteria

## Happy Path

* [x] AC-001: A valid request returns every nightly inclusive-tax price using the Availability-owned base-price fallback or local-date override, Property currency, total, policy, and a versioned server-authenticated fingerprint.

## Business Rules

* [x] AC-002: The Quote observes inclusive/exclusive stay dates, available units, Room Type stay limits and occupancy, one adult per room, the Property-local 365-day check-in horizon, 30-night maximum stay, and required injected request room-count cap.
* [x] AC-003: Producing a Quote does not change Room Night reserved units.

## Failure Cases

* [x] AC-004: Caller-only malformed or invalid input is rejected before I/O; Property/RoomType-dependent horizon, stay, and occupancy rules are rejected before Availability-table reads or locks; unavailable input causes no supply mutation.

## Regression Requirements

* [x] AC-005: Quotes remain non-persistent and do not create a Reservation dependency.

## Security Contract

* [x] AC-006: The fingerprint is an HMAC-SHA-256 using a purpose-derived configured signing key, changes when quote terms or signing key change, and exposes neither raw supply counts nor signing material.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `packages/booking/availability/test/quote.integration.test.ts` | priced available nights and property policy | complete deterministic Quote and stable authenticated fingerprint |
| `AC-002` | unit/integration | `packages/booking/availability/test/quote.test.ts` and `quote.integration.test.ts` | 365-day local horizon, Room Type min/max, 30-night, cap, and occupancy fixtures | each static rule is rejected before I/O; owner-dependent rule before Availability read |
| `AC-003` | integration | `packages/booking/availability/test/quote.integration.test.ts` | before/after Room Night query | successful Quote leaves reserved units unchanged |
| `AC-004` | unit/integration | `packages/booking/availability/test/quote.test.ts` and `quote.integration.test.ts` | malformed input, owner-dependent invalidity, and insufficient supply | staged rejection boundaries; no Availability lock or mutation |
| `AC-005` | architecture | `tests/architecture/booking-availability-boundaries.test.ts` and package schema scan | completed package | no Quote persistence, Reservation import, or cross-module ownership |
| `AC-006` | unit/integration | `packages/booking/availability/test/quote.test.ts` and `quote.integration.test.ts` | same quote terms evaluated with repeat and distinct key material | stable same-key HMAC fingerprint; different key produces a different fingerprint without exposing key or stock |

## Repository Gate

`make verify` passed on the second run on 2026-09-21: both typechecks, unit (128 files / 1,380 tests), admin (32 files / 351 tests), and integration (109 files / 915 tests). The first full run had three integration failures tracked in tickets 101, 106, and 107; all three files passed alone and in the second full run. SW-122's Quote unit, PostgreSQL Quote, architecture, and Booking Availability integration checks also passed.
