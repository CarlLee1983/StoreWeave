# 105 — Atomic Quote revalidation and Room Night reservation

**What to build:** Add an Availability-owned transaction capability that locks every affected Room Night in ascending local-date order, recomputes the current Quote terms, compares the caller's expected fingerprint, and reserves supply only when the terms still match.

**Status:** complete — implemented by SW-148 and SW-149; SW-125's exact-match Reservation creation prerequisite is satisfied.

## Acceptance

- [x] The capability accepts the caller's transaction, booking request, current time, and expected Quote fingerprint.
- [x] It acquires all locks needed for a coherent Quote snapshot and Room Night mutation in the documented fixed order; concurrent supply or Quote-affecting changes cannot slip between revalidation and reservation.
- [x] A matching Quote and sufficient supply reserves all nights atomically and returns the exact frozen terms.
- [x] Changed terms return a replacement Quote without reserving; insufficient supply returns unavailable without partial reservation.
- [x] Fingerprint comparison handles malformed or tampered values without timing-sensitive equality and defines active/retired signing-key behavior.
- [x] Real PostgreSQL concurrency tests show no double allocation, partial range reservation, or stale-price reservation; `make verify` passes.

## Boundaries

- Depends on SW-122 and SW-123; must be complete before SW-125.
- Availability remains the only writer of Room Night tables. Reservation consumes this capability and never writes Availability tables directly.
- Requires Sol/high design and independent Sol/high review because it combines price integrity, database locking, and persistent allocation.

## Evidence

SW-122 deliberately exposes a read-only Quote capability. SW-123 provides separate Room Night reserve/release operations. SW-148 added the Property-owned locked Quote facts needed to keep policy and Room Type rules stable; SW-149 adds the atomic Availability capability that rechecks the Quote and reserves supply in the caller's transaction. Quoting before separate locks permits a concurrent change; reserving first changes the available-unit snapshot covered by the Quote fingerprint.

SW-149 acceptance evidence: `specs/stories/SW-149-atomic-quote-reservation/acceptance.md`. Full `make verify` passed on 2026-09-21: typechecks, unit 134 files / 1,410 tests, admin 32 files / 351 tests, and integration 110 files / 923 tests.
