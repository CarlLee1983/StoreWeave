# SW-164 — Dining settings and schedule

## Goal

Own one venue’s table types, schedule, booking window, duration, and timezone.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Create Dining-owned schema and commands for a single venue, table type capacity/count, occupancy duration including turnover, weekly start times, start-date overrides, and earliest/latest booking limits. Resolve local starts in the venue timezone, excluding nonexistent or ambiguous DST times. Keep immutable request snapshots; lock timezone after any request exists. Register only minimum workspace/build metadata required for this new package.
- Out of scope: Public submission, capacity commitment, Notification integration, and a second venue.

## Dependencies

SW-163

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Unit timezone/schedule tests plus PostgreSQL command and snapshot tests. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
