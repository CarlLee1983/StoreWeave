# SW-166 — Dining public requests

## Goal

Accept anonymous requests only for currently available starts, with stable submission replay.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Expose available starts and a request command. Validate name, phone, email, party size, optional free-text note, selected start, and configured minimum/maximum booking window. Save start, duration, and party snapshots. Apply separate source and recipient frequency limits before insert or receipt enqueue; use a stable non-raw source identity supplied by the trusted adapter. One submission key replays its request number; a distinct submission key may create another request with identical content.
- Out of scope: Anonymous status lookup, accepting a request, email rendering, and operator management.

## Dependencies

SW-163, SW-164, SW-165

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL idempotency/rate-limit tests and available-start boundary tests; source identity is a trusted contract input. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
