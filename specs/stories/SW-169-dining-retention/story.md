# SW-169 — Dining retention and anonymization

## Goal

Apply Dining retention cutoffs and clear customer data across owned and Base records.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Calculate cutoffs from rejection, cancellation, or planned end of accepted and expired pending records using the required positive policy. Anonymize contact, notes, and customer-visible reasons in Dining. A rejection after an already-anonymized pending request may record the state change but must discard any newly supplied free-text reason. Ask Base Notification to erase by opaque reference; keep jobs and audit sanitized. Coordinate retries and cutoff so no mail sends after erase. Keep state/count/dedupe evidence without identifiers.
- Out of scope: A hidden default retention period, direct Base table edits, and deleting evidence needed for dedupe/audit.

## Dependencies

SW-162, SW-163, SW-167, SW-168

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL lifecycle/cutoff and send/erase race tests, including late rejection. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
