# SW-170 — Dining public pages

## Goal

Declare Dining-owned public request views and the successful submission state.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/dining/reservation`.
- In scope: Contribute module-owned availability/form/result page declarations. Render only eligible starts, required contact fields, party size, and optional notes. Generate a stable submission key per rendered attempt and show the returned number; network retry of that attempt preserves the key.
- Out of scope: Anonymous request tracking, cancellation/change page, Theme implementation, and direct Mail access.

## Dependencies

SW-166, SW-168

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Module page contract tests and form/retry integration assertions. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
