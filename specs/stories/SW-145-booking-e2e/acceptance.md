# Acceptance Criteria

## Happy Path

* [x] AC-001: Clean Booking E2E journey covers search, Quote, Reservation, qualified payment, confirmation, one-time management access, cancellation, and refund work.

## Business Rules

* [x] AC-002: Last-room race yields one success; stale Quote/unavailable yields no Reservation; cancellation/expiry releases every Room Night.
* [x] AC-003: Payment concurrency yields one winning confirmation; Late/Excess Payment triggers trackable refund/notification and never revives/reoccupies.
* [x] AC-004: Access Grant is single-use/clean-URL and Account linking is explicit only.
* [x] AC-005: Retention anonymization after its configured deadline removes no-longer-needed Booker/Guest PII while retaining necessary payment, refund, and audit evidence.

## Failure Cases

* [x] AC-006: Invalid request, payment failure/replay, expired grant, unauthorized claim, cancellation deadline, refund/notification failure, and early or invalid retention anonymization are asserted.

## Regression Requirements

* [x] AC-007: Tests use no real ECPay/SMTP/deployment service and preserve those external gates.

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

## Repository evidence

* `tests/integration/booking-release-journey.test.ts` boots the selected Booking server projection with its Theme and `mock-payment` Extension, then runs search through refund on a clean Booking database.
* `tests/integration/booking-e2e.test.ts` joins HTTP, Worker and PostgreSQL for management, explicit Account claim, last-room and callback races, refund failure, and retention. It compares payment, refund invocation and earlier audit rows before and after anonymization.
* `tests/integration/booking-reservation.test.ts` covers callback versus cancellation/expiry, deadline extension versus the original expiry command, notification failure, and retention guards. `tests/integration/booking-availability-quote-reservation.test.ts` covers changed cancellation policy and stale Quote replacement.
* Payment and notification fixtures are local. ECPay staging refund UAT, real SMTP, and deployment remain separate release gates under Spec 0011; these tests do not satisfy them.
