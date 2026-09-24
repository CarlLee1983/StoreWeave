# Acceptance Criteria

## Happy Path

* [x] AC-001: Authorized human operator can list and detail Reservations and read bounded payment-attempt evidence through declared Booking Reservation Queries; HTTP/Admin consumers need no direct table access.

## Business Rules

* [x] AC-002: List paging and filters are bounded, validated and stable across equal creation timestamps; list rows contain no Booker/Guest contact data, notes, credential material or provider payload.
* [x] AC-003: Detail and payment/refund/notification evidence expose only necessary fields and safe correlation; retention-anonymized PII stays absent, while Late/Excess Payment and refund failure remain traceable.

## Failure Cases

* [x] AC-004: Missing permission, service/anonymous actor, unknown Reservation (including refund/notification evidence reads), invalid filter/range/page, and cross-Reservation evidence request fail safely without disclosing PII; an existing Reservation with no evidence returns an empty page.

## Regression Requirements

* [x] AC-005: Existing Account/management self-read, refund processing and Reservation state behavior remain unchanged; any additive Booking index migration matches schema and does not touch Commerce.
* [x] AC-006: Focused real-database Query tests and the required repository `make verify` gate pass at the integration checkpoint.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | operator Query suite | operator, Reservation and payment attempts | declared list/detail/evidence results; no direct DB consumer |
| `AC-002` | integration test | pagination/filter matrix | equal timestamps, mixed statuses and Room Types | deterministic bounded pages and redacted list DTO |
| `AC-003` | integration test | evidence/retention matrix | Late/Excess, failed refund, notification, anonymized row | correlated safe evidence, erased PII remains null |
| `AC-004` | integration test | authorization/validation matrix | forbidden actors and malformed or foreign IDs | safe forbidden/not-found/validation outcomes |
| `AC-005` | architecture/integration test | self-read and schema parity checks | existing access paths and migrations | no state regression or Commerce boundary change |
| `AC-006` | verification | focused suite and `make verify` | integrated candidate | all required checks pass at one recorded revision |
