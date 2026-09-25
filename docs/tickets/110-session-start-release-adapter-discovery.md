# 110 — Session-start guard recognizes Booking release adapter

**What to fix:** The session-start architecture test identifies release adapters
only when they export a value literally named `httpAdapter`. Booking exports a
typed `bookingHttpAdapter`, so the test wrongly labels its legitimate
`session-start` import as a non-adapter caller.

**Status:** implemented and verified locally.

## Acceptance

- [x] The test discovers every typed `ReleaseHttpAdapter`, regardless of export name.
- [x] Every discovered adapter still exposes the single `startSession` implementation.
- [x] The page session-effects wiring assertion applies to adapters that compose storefront pages; an API-only adapter has no page effects to wire.
- [x] Focused architecture test and `make verify` pass.

## Boundary

- Test discovery only; do not change session issuance or Booking route behavior.
