# SW-174 — Dining release assembly

## Goal

Assemble only Dining modules into an independently selectable Product Release.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/releases/dining`.
- In scope: Complete ReleaseDefinition, role/module grant map, runtime config, backend, worker, storefront, Admin, and CLI projections. Select the Dining module, suitable Base/Platform capabilities, and Dining default Theme. Document package-owned runtime configuration, database identity, startup, retention job, and rollback expectations.
- Out of scope: Commerce/Booking domain imports, checkout/payment coupling, root release registry, and deployment publication.

## Dependencies

SW-163, SW-170, SW-171, SW-172, SW-173

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Release definition/projection tests, import-boundary check, and package build/type checks. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
