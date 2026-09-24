# Acceptance Criteria

## Happy Path

* [x] AC-001: Confirmed, cancelled, and payment-expiring Reservation events create the intended durable Booking notification requests.

## Business Rules

* [x] AC-002: Mapping/template wording remains Booking-owned while Base Notification owns delivery/retry/logging.
* [x] AC-003: Access emails use a short-lived Grant and never expose a raw management token.

## Failure Cases

* [x] AC-004: Delivery or mapping failure is operator-visible and does not roll back Reservation state.

## Regression Requirements

* [x] AC-005: The Story does not implement Base delivery, SMTP, or provider adapters.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | event-mapping test | Reservation event fixtures | durable request per template |
| `AC-002` | architecture | capability boundary test | mapped notification | Base owns delivery only |
| `AC-003` | security test | rendered access-mail/output scan | issued Grant and token | Grant only; no raw token leak |
| `AC-004` | integration | failed delivery fixture | Base delivery error | failure evidence; Reservation unchanged |
| `AC-005` | architecture | package dependency scan | completed package | no Base implementation edits/imports |
