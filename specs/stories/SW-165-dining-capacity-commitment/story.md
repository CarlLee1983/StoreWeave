# SW-165 — Dining capacity commitment

## Goal

Provide one atomic capacity rule for acceptance and supply edits.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Implement a transaction-scoped capacity commitment operation with half-open occupancy interval evaluation, smallest available fitting table type with larger-type fallback, and a PostgreSQL serialization strategy shared by that operation, cancellation, table-count/capacity edits, type disablement, and schedule closure. Validate all not-yet-ended commitments over their full intervals; retain historical table-type snapshots. SW-167 invokes the operation from the operator decision command.
- Out of scope: Public request workflow, concrete table numbers, table joining, and Commerce/Booking inventory contracts.

## Dependencies

SW-164

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL concurrency and interval tests, including midnight and competing settings edits. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
