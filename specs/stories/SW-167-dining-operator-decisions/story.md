# SW-167 — Dining operator decisions

## Goal

Decide pending requests and cancel accepted reservations without violating current supply.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Implement authorized accept, reject, and pre-start cancel commands. Accept atomically rechecks current start openness, full saved-duration capacity, and smallest fitting type; rejection may carry an optional customer-visible reason; cancellation requires a customer-visible reason and releases capacity. Persist state transitions and sanitized actor/time/result audit.
- Out of scope: Email delivery, customer self-service, rescheduling, arrival/no-show/completed states, and forced overbooking.

## Dependencies

SW-165, SW-166

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

PostgreSQL transition, authorization, concurrency, and audit tests. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
