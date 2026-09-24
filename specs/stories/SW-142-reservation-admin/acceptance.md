# Acceptance Criteria

## Happy Path

* [x] AC-001: Authorized operator can list/detail Reservations, whole-cancel with reason/refund amount, and see payment/refund/notification evidence.

## Business Rules

* [x] AC-002: Operator refund amount is zero through amount received, audit reason is mandatory, and refund failure never restores Reservation or Room Nights.
* [x] AC-003: Late/Excess Payment, refund failure, and notification failure are operator-visible with correlation evidence.

## Failure Cases

* [x] AC-004: Forbidden actor, missing Reservation, invalid amount/reason, state conflict, and unavailable refund action are safely rejected.

## Regression Requirements

* [x] AC-005: Credentials/unnecessary PII are redacted and browser Admin code imports no provider/DB implementation.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | mounted Admin route and operator HTTP integration | `packages/booking/reservation/test/admin.test.ts`, `tests/integration/booking-public-http.test.ts` | authorized operator + Reservation fixtures | list/detail/cancel/refund retry use declared capabilities; SW-143 selects the release route |
| `AC-002` | command integration and mounted Admin tests | `tests/integration/booking-reservation.test.ts`, `packages/booking/reservation/test/admin.test.ts` | received and unpaid Reservations, failed asynchronous refund | exact zero/partial/full decision and audit reason; cancellation and Room Night release persist after refund failure |
| `AC-003` | mounted Admin and operator query integration | `packages/booking/reservation/test/admin.test.ts`, `tests/integration/booking-reservation.test.ts` | late/excess, failed refund, notification mapping/delivery evidence | visible references, status and safe failure codes |
| `AC-004` | command/HTTP and Admin tests | `tests/integration/booking-reservation.test.ts`, `tests/integration/booking-public-http.test.ts`, `packages/booking/reservation/test/admin.test.ts` | forbidden/missing/conflict/invalid fixtures | safe, distinct rejection and original-key retry after uncertain transport |
| `AC-005` | bundle import and mounted Admin tests | `tests/architecture/booking-reservation-admin-artifact.test.ts`, `packages/booking/reservation/test/admin.test.ts` | populated sensitive detail and browser bundle | unnecessary PII hidden and no server, persistence, provider or Commerce import |
