# Acceptance Criteria

* [x] AC-001: An explicit `rateLimit` declaration throttles a GET route with its declared bucket.
* [x] AC-002: Existing POST throttling and undeclared routes preserve their behavior.
* [x] AC-003: Booking management can use the existing `auth` bucket on every route without a new global bucket.
* [x] AC-004: Focused server tests and `make verify` pass.

ForgePilot `EV-006` records a passing full snapshot gate; candidate freshness remains a separate ForgePilot check.
