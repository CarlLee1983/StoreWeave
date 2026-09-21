# Acceptance Criteria

## Happy Path

* [ ] AC-001: Clean Booking E2E journey covers search, Quote, Reservation, qualified payment, confirmation, one-time management access, cancellation, and refund work.

## Business Rules

* [ ] AC-002: Last-room race yields one success; stale Quote/unavailable yields no Reservation; cancellation/expiry releases every Room Night.
* [ ] AC-003: Payment concurrency yields one winning confirmation; Late/Excess Payment triggers trackable refund/notification and never revives/reoccupies.
* [ ] AC-004: Access Grant is single-use/clean-URL and Account linking is explicit only.
* [ ] AC-005: Retention anonymization after its configured deadline removes no-longer-needed Booker/Guest PII while retaining necessary payment, refund, and audit evidence.

## Failure Cases

* [ ] AC-006: Invalid request, payment failure/replay, expired grant, unauthorized claim, cancellation deadline, refund/notification failure, and early or invalid retention anonymization are asserted.

## Regression Requirements

* [ ] AC-007: Tests use no real ECPay/SMTP/deployment service and preserve those external gates.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | E2E integration test | Booking core journey | clean DB + qualified test provider | completed observable journey |
| `AC-002` | concurrency/integration test | last-room/stale/cancel/expiry cases | parallel requests and changed fixtures | exact one success/no leak/release all nights |
| `AC-003` | concurrency integration test | callback/cancel/expiry/extension matrix | competing payment lifecycle events | serialized result, refund evidence, no revival |
| `AC-004` | E2E integration test | grant/claim journey | fresh grant and account fixtures | one redemption/clean redirect/explicit claim only |
| `AC-005` | E2E integration test | retention anonymization journey | elapsed retention deadline and preserved payment/refund/audit records | PII anonymized; required evidence retained |
| `AC-006` | integration test | failure matrix | each listed negative fixture | asserted safe outcome and evidence |
| `AC-007` | test configuration review | provider/notification fixture config | E2E suite | local mocks only; external gates listed |
