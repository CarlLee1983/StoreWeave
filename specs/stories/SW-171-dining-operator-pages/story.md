# SW-171 — Dining operator pages

## Goal

Declare operator settings, lists, decisions, and notification handling views.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Contribute permission-gated Admin pages for settings; pending requests; accepted reservations by date; rejected and cancelled records; delivery status and audited manual resend. Present rejection and cancellation reasons at the correct action, and show “個資已清除，無法通知” for anonymized late rejection.
- Out of scope: Bypassing module commands, override capacity actions, anonymous status UI, and Theme styling.

## Dependencies

SW-164, SW-167, SW-168, SW-169

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Admin declaration/UI tests plus authorized/unauthorized command wiring tests. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
