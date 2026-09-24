# 109 — Enforce declared management GET rate limits

**What to build:** SW-136 declares a rate limit on every management endpoint, but
the shared release-server pre-handler currently applies declared buckets only to
POST requests. Make the declared limiter cover GET and the other methods used by
explicit routes.

**Status:** implemented — focused integration and ForgePilot `EV-006` full
snapshot gate pass; the current candidate still needs fresh ForgePilot verification.

## Acceptance

- [x] A GET route with an explicit `rateLimit` declaration is throttled by its declared bucket.
- [x] Existing POST throttling and routes without a declared bucket retain their behavior.
- [x] Management GET and state-changing routes can use the existing `auth` bucket without adding a new global bucket.
- [x] Focused server tests and `make verify` pass at the recorded `EV-006` snapshot.

## Boundaries

- Own only shared release-server request-rate enforcement and its tests; do not implement Booking HTTP or change bucket thresholds.
