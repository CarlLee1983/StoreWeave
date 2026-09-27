# SW-161 — Notification explicit resend

## Goal

Expose a product-neutral, authorized operator action to resend failed or unknown email with consistent evidence.

## Source and boundary

Source: [Spec 0012](../../../docs/specs/0012-dining-product-release.md) and [ADR 0053](../../../docs/adr/0053-dining-is-a-separate-product-release.md). Each Story is a proposed implementation unit; implementation and Git/external writes require their own authorization. Keep Dining rules out of Platform/Base, Commerce, and Booking.

- Owning scope: `packages/platform/notifications`.
- In scope: Add a Notification capability for explicit operator retry of failed delivery and deliberate resend of unknown delivery, using the existing Mail resend seam. Require caller identity/authorization context, record actor and result, and synchronize Notification and Mail attempt/status evidence.
- Out of scope: Automatic unknown replay, Dining-specific status names, and direct Dining access to Mail records.

## Dependencies

None; can proceed independently.

## Risk and constraints

High: shared persistent delivery/erasure or concurrent capacity/data integrity. Implement this as a working slice with focused tests and no unrelated product changes. New-package Stories may include the smallest root workspace registrations required for build/type resolution; repository-wide release selection belongs to SW-175. Persistent erasure and commitment migrations must be additive; after real traffic, roll back with a compatible application or a forward correction, never by restoring cleared personal data.

## Verification

Contract and integration tests over Notification plus Mail attempts; existing product regression tests. Complete the repository's `make verify` gate at the integration checkpoint. Acceptance criteria are in [acceptance.md](acceptance.md).
