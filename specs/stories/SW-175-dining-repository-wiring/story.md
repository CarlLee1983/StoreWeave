# SW-175 — Dining repository wiring

## Goal

Select Dining in repository build and deployment examples so all existing checks can discover the release.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: repository-level selection and build wiring only: `scripts/releases.mjs`, root TypeScript and Vitest configuration, `Dockerfile`, `pnpm-lock.yaml`, deployment examples, and related architecture/operations documentation. This is the explicit repository wiring exception required to select a new Product Release; product packages remain owned by SW-160–SW-174.
- In scope: Register Dining in root release selection/build, TypeScript/Admin/integration gates, package lock/build metadata, and deployment examples. Update related architecture/operations guidance when implementation lands.
- Out of scope: Production deployment, real customer data migration, unrelated release refactors, and automatic Git writes.

## Dependencies

SW-174

## Risk and constraints

Medium: root release selection and regression. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs here. After real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Release build selection, root typechecks, existing release regression, and final boundary/diff review. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
