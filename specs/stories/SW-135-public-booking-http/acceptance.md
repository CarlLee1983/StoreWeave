# Acceptance Criteria

## Happy Path

* [ ] AC-001: Public Booking routes validate browse/search and Quote requests, create a Reservation only through its capability, initiate payment through its capability, and expose only those explicit public operations.
* [ ] AC-002: Payment initiation exposes neither provider secrets nor persistence details and delegates its result to the Reservation payment capability.

## Business Rules

* [ ] AC-003: Quote creation reserves no Room Night; stale price/policy returns a replacement Quote and sold-out creation returns unavailable.
* [ ] AC-004: Public routes contain no Access Grant redemption, management-cookie/session, Account claim, update, cancellation, or callback behavior.

## Failure Cases

* [ ] AC-005: Invalid public inputs and unauthorized payment initiation are rejected without protected Reservation disclosure.

## Regression Requirements

* [ ] AC-006: Browser artifacts do not import server/provider/DB code and no generic REST-to-Command endpoint is added.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | public Booking HTTP adapter suite | valid browse/search/Quote/create/payment fixtures | explicit routes invoke validated capabilities |
| `AC-002` | integration test | payment-initiation response case | valid public Reservation payment request | capability result only; no provider secret/persistence detail |
| `AC-003` | integration test | Quote mismatch/unavailable cases | changed price/policy and exhausted Room Night | replacement Quote or recognizable unavailable; no Reservation |
| `AC-004` | route inventory test | public route inventory | built public adapter | management and callback operations are absent |
| `AC-005` | integration test | invalid DTO/payment-auth matrix | malformed and unauthorized requests | validation/authorization errors without PII |
| `AC-006` | architecture test | target import and route inventory | built public adapter | no forbidden import or generic command route |
