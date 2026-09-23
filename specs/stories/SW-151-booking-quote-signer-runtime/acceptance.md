# Acceptance Criteria

* [x] AC-001: Booking Availability receives a `booking-quote`-only Keyring facade resolved from configured `security.signingKeys` secret references, without another secret source.
* [x] AC-002: Build manifest and target projections contain no signing material and can construct module metadata without it.
* [x] AC-003: A missing or invalid required signing key stops startup before the Booking Quote endpoint is available.
* [x] AC-004: A production-style synthetic Release bootstrap proves Quote HMAC uses the Keyring resolved by bootstrap from the configured secret reference; SW-138 will wire the production Booking Release.
* [x] AC-005: Signing material and derived keys do not appear in manifests, logs, errors, or public Quote output.
* [x] AC-006: Focused Platform/runtime tests and `make verify` pass.

ForgePilot `EV-006` records a passing full snapshot gate; candidate freshness remains a separate ForgePilot check.

Source: [ticket 104](../../../docs/tickets/104-booking-quote-signer-runtime-seam.md).
