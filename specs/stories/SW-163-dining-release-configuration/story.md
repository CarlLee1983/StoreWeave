# SW-163 — Dining release configuration

## Goal

Define the Dining runtime configuration contract and reject unsafe public-entry startup configuration.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/releases/dining`.
- In scope: Create the Dining release package configuration parser for a required positive retention-days value and separate positive source and recipient submission limits, each with a positive time window. Expose validated settings to the module without embedding policy defaults. Keep package registration limited to the minimum workspace/build wiring needed to type-resolve a new package.
- Out of scope: Dining business storage, public routes, deployment of a live release, and broader repository release selection.

## Dependencies

None; can proceed independently.

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Configuration unit tests and package resolution/type checks; no live public endpoint is required in this Story. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
