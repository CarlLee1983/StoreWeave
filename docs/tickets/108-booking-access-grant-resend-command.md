# 108 — Booking Access Grant resend command

**What to build:** SW-136 needs a Reservation-owned command that authorizes a
Booker, rotates the single-use Access Grant, and durably requests delivery to the
current Booker email without returning grant material through HTTP.

**Status:** implemented — focused integration and ForgePilot `EV-006` full
snapshot gate pass; the current candidate still needs fresh ForgePilot verification.

## Acceptance

- [x] Authenticated owning Account or valid management credential may request a resend; an unrelated caller cannot.
- [x] Authorization, current Booker email selection, grant rotation, audit, and notification request use the Reservation-owned transaction boundary.
- [x] Only the new Grant is deliverable; replayed/revoked grants fail, and the command returns no raw Grant or management token.
- [x] Delivery failure remains operator-visible and does not disclose secrets or undo an already committed Reservation state.
- [x] Focused integration and `make verify` pass at the recorded `EV-006` snapshot.

## Boundaries

- No HTTP adapter, Base Notification delivery changes, migration, or new secret source.
- Use existing Booking notification mapping and Reservation Access Grant issuer.
- Requires Sol/high design and independent Sol/high review because it handles credential rotation and personal data.
