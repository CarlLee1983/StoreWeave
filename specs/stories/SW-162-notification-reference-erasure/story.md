# SW-162 — Notification reference erasure

## Goal

Clear Notification-owned personal data and coordinate Mail erasure through a product-neutral reference.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/platform/notifications`.
- In scope: Add a scoped erasure capability that removes recipient, payload, diagnostics, and other identifying Notification data, invokes Mail-owned erasure by opaque reference, and preserves non-identifying dedupe/audit facts. Serialize erasure against dispatch, retries, and manual resend.
- Out of scope: Computing Dining retention cutoffs or allowing Dining to mutate Base tables.

## Dependencies

SW-160, SW-161

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL dispatch/erase and resend/erase race tests; Base, Commerce, Booking regression checks. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
