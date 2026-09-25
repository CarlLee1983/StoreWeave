# Acceptance Criteria

## Happy Path

* [x] AC-001: Booking Release passes a validated dedicated operator alert Email to SW-155 and produces a Late-specific operator request at that recipient.

## Business Rules

* [x] AC-002: Server and Worker use the same selected Booking configuration; Site contact Email, Booker Email, callback data and admin-role enumeration do not become fallback recipients.
* [x] AC-003: Retryable or historical missing alerts reconcile to one request per Late Attempt after configuration, including exhausted jobs, without another refund or Reservation transition. Previously materialized requests to a wrong mailbox remain visibly failed and are not silently retargeted.

## Failure Cases

* [x] AC-004: Missing or invalid operator alert Email rejects Booking startup before HTTP/Worker processing with an actionable config error.

## Regression Requirements

* [x] AC-005: Base and Commerce config, Booking target isolation, existing notification behavior and repository `make verify` remain intact; external SMTP/UAT/deployment gates remain open.

## Acceptance Evidence

| AC | Method | Required observation |
| --- | --- | --- |
| `AC-001` | selected Booking Release integration | exact recipient on Late-specific request |
| `AC-002` | config/projection and recipient test | one source across targets; no fallback to unrelated addresses |
| `AC-003` | retry/reconciliation integration | exactly one request, unchanged refund and Reservation |
| `AC-004` | config/bootstrap failure tests | missing and malformed values stop startup |
| `AC-005` | Base/Commerce regression, artifact checks and `make verify` | no cross-product or external-gate claim |
