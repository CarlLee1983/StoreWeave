# Acceptance Criteria

## Happy Path

* [x] AC-001: Clean Booking E2E journey covers search, Quote, Reservation, qualified payment, confirmation, one-time management access, cancellation, and refund work.

## Business Rules

* [x] AC-002: Last-room race yields one success; stale Quote/unavailable yields no Reservation; cancellation/expiry releases every Room Night.
* [x] AC-003: Payment concurrency yields one winning confirmation; Late and Excess Payment each trigger a trackable refund without reviving or reoccupying, and Late Payment additionally triggers a distinct operator notification.
* [x] AC-004: Access Grant is single-use/clean-URL and Account linking is explicit only.
* [x] AC-005: Retention anonymization after its configured deadline removes no-longer-needed Booker/Guest PII while retaining necessary payment, refund, and audit evidence.

## Failure Cases

* [x] AC-006: Invalid request, payment failure/replay, expired grant, unauthorized claim, cancellation deadline, refund/notification failure, and early or invalid retention anonymization are asserted.

## Regression Requirements

* [x] AC-007: Tests use no real ECPay/SMTP/deployment service and preserve those external gates.

## Acceptance Evidence

Test filenames in the evidence column are under `tests/integration/`.

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | E2E integration test | `booking-release-journey.test.ts` composed journey; `booking-e2e.test.ts` search-to-retention journey | clean DB + qualified local providers | completed observable journey |
| `AC-002` | concurrency/integration test | `booking-e2e.test.ts` last-room/stale/expiry; `booking-availability-quote-reservation.test.ts` policy change | parallel requests and changed fixtures | exact one success/no leak/release all nights |
| `AC-003` | concurrency and E2E integration tests | `booking-e2e.test.ts` Late callback/recipient/refund; `booking-reservation.test.ts` initiation/callback race and replay | competing payment lifecycle events | one winner, Attempt-linked refunds, Late-specific template and operator recipient, no revival |
| `AC-004` | E2E integration test | `booking-e2e.test.ts` management grant and Account claim journey | fresh grant and account fixtures | one redemption/clean redirect/explicit claim only |
| `AC-005` | E2E integration test | `booking-e2e.test.ts` pre/post retention snapshots | elapsed retention deadline and preserved payment/refund/audit records | PII anonymized; required evidence retained |
| `AC-006` | integration test | `booking-e2e.test.ts` failure cases; `booking-reservation.test.ts` payment replay/notification failure | each listed negative fixture | asserted safe outcome and evidence |
| `AC-007` | test configuration review | `booking-release-journey.test.ts` mock Extension; `booking-e2e.test.ts` local provider | E2E suites | no real external service; external gates listed |

## Repository evidence

* `tests/integration/booking-release-journey.test.ts` boots the selected Booking server projection with its Theme and `mock-payment` Extension, then runs search through refund on a clean Booking database.
* `tests/integration/booking-e2e.test.ts` joins HTTP, Worker and PostgreSQL for management, explicit Account claim, last-room and callback races, refund failure, and retention. It compares payment, refund invocation and earlier audit rows before and after anonymization.
* `tests/integration/booking-reservation.test.ts` covers callbacks after completed cancellation/expiry, deadline extension versus the original expiry command, Late initiation/callback concurrency, notification failure, and retention guards. `tests/integration/booking-availability-quote-reservation.test.ts` covers changed cancellation policy and stale Quote replacement.
* Payment and notification fixtures are local. ECPay staging refund UAT and deployment remain separate gates under Spec 0011; SW-146 also tracks real SMTP. These tests do not satisfy those external gates.
* The Late Payment E2E assertion selects `kind = 'late-payment'`, joins the named Attempt and `late_payment` refund, and checks the exact Base template, recipient and variables. An earlier cancellation notice cannot satisfy it.
* The SW-155／SW-156 implementation passed `make verify` in the `feat/sw-155-156-late-payment` worktree on 2026-09-25: 155 unit files／1,524 tests, 32 Admin files／351 tests, and 115 integration files／1,021 tests. This covers the exact Late-specific E2E assertion and Booking startup rejection. External ECPay staging refund UAT, real SMTP, and deployment remain separate gates.
