# SW-173 — Dining HTTP adapters

## Goal

Expose public and operator Dining contracts at the trusted HTTP boundary.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `apps/api`.
- In scope: Add Dining public availability/submission and authenticated operator settings/list/decision/resend route adapters. Derive a stable opaque source key from the trusted request boundary for rate limiting, validate idempotency keys and payloads, and route all operations through declared module contracts with authorization. Keep response errors explicit.
- Out of scope: Direct SQL, direct Mail/Notification record access, anonymous status endpoint, and Commerce/Booking route changes.

## Dependencies

SW-166, SW-167, SW-168, SW-171

## Risk and constraints

Medium: package-local contract and integration behavior. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

HTTP contract and authorization tests with trusted/untrusted source fixtures. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
