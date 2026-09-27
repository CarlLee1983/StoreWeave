# SW-160 — Mail reference erasure

## Goal

Provide product-neutral erasure by opaque notification reference, including queued and in-flight mail.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/platform/mail`.
- In scope: Own a reference-scoped erasure contract, send/erase serialization, and sanitized durable evidence. Remove recipient addresses, rendered subject/body, diagnostics, and other customer-identifying fields from Mail-owned records and work. Fence queued, retrying, and in-flight sends before reporting erasure complete.
- Out of scope: Dining policy, Notification-owned records, cross-product behavior changes, and blanket deletion of non-identifying dedupe evidence.

## Dependencies

None; can proceed independently.

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL race tests for send/erase fencing; Mail contract and regression tests. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
