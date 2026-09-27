# SW-168 — Dining notification mapping

## Goal

Send request and decision email through Base Notification while preserving Dining state.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Map received, accepted, rejected, and cancelled events to Notification using stable opaque non-PII references. Include one request/reservation number throughout. Surface delivery failed/unknown status to authorized queries and use the Base explicit resend capability for audited operator action; prevent implicit resend of unknown. Decision transactions must commit independently of delivery.
- Out of scope: Mail transport implementation, anonymous status page, and exposing assigned table type in customer email.

## Dependencies

SW-161, SW-166, SW-167

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Notification contract tests and PostgreSQL outbox/delivery-failure tests; customer template assertions. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
