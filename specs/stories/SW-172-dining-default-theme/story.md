# SW-172 — Dining default theme

## Goal

Render Dining page declarations with a complete default theme.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/themes/dining-default`.
- In scope: Create a Dining-specific Theme package for public availability, request form, confirmation, and shared layout. Render module-declared views and escape customer-supplied text. Register only the package metadata necessary to build the new Theme.
- Out of scope: Domain decisions, source identity derivation, and a generic cross-product design rewrite.

## Dependencies

SW-170

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Theme render/escaping tests and build/type checks. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
