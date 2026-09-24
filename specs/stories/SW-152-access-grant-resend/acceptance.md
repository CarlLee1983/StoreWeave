# Acceptance Criteria

* [x] AC-001: An owning Account or valid management credential can request a resend; unrelated, expired, or revoked authority is rejected.
* [x] AC-002: The command uses the current Booker email, rotates the Grant once, records audit, and requests Booking notification delivery in its owned transaction boundary.
* [x] AC-003: The response has no raw Grant or management token; only the new Grant is deliverable, and the previous one cannot redeem.
* [x] AC-004: Delivery failure is operator-visible without leaking credentials or undoing a committed Reservation state.
* [x] AC-005: Focused integration tests and `make verify` pass.

ForgePilot `EV-006` records a passing full snapshot gate; candidate freshness remains a separate ForgePilot check.
