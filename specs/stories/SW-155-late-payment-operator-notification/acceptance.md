# Acceptance Criteria

## Happy Path

* [x] AC-001: The first persisted Late Payment from callback or Provider initiation commits its required full refund and a durable Late-specific event; asynchronous processing creates exactly one operator notification request correlated to Reservation, Attempt and refund.

## Business Rules

* [x] AC-002: Replayed or competing initiation/callback outcomes do not duplicate the alert; two Late Attempts on one Reservation have distinct correlations. Excess Payment and ordinary cancellation do not produce a Late Payment alert.
* [x] AC-003: The recipient is the validated operator input. Alert content and durable evidence contain no Booker Access Grant, management token, raw provider text or unnecessary personal data.
* [x] AC-004: Retention preserves the Late Attempt, refund, operator notification and audit correlation after Booker/Guest personal data is erased.

## Failure Cases

* [x] AC-005: Missing recipient leaves retryable evidence that the existing job/outbox repair path can redrive after exhaustion; malformed/stale events and Base delivery failure leave their actual safe retryable, dead-letter or terminal state without rolling back payment/refund or reoccupying Room Nights. Correcting a wrong mailbox does not silently retarget or duplicate an immutable Base request.
* [x] AC-006: A bounded reconciliation run alerts for preexisting Late Attempts with refunds and no alert, without repeating charges or refunds.

## Regression Requirements

* [x] AC-007: Booking notification migration remains additive; existing confirmed/cancelled/payment-expiring delivery and operator evidence remain valid, and `make verify` passes.

## Acceptance Evidence

| AC | Method | Required observation |
| --- | --- | --- |
| `AC-001` | real PostgreSQL initiation/callback → outbox → Base Notification integration | committed refund and event, then one Late-specific kind/template and request linked to that Attempt and refund from either path |
| `AC-002` | replay and concurrency integration | stable Attempt-derived reference; two Late Attempts remain distinct; no duplicate or misclassified alert |
| `AC-003` | notification payload, recipient, DB and log inspection | dedicated operator recipient and no credential/provider/PII leak |
| `AC-004` | before/after retention integration | earlier financial, notification and audit records remain correlated |
| `AC-005` | missing-recipient, exhausted job retry, wrong-mailbox and Base delivery failure injection | financial state commits; missing-recipient event redrives after repair; immutable failed request stays visible without unsafe retargeting |
| `AC-006` | bounded historical Late fixture and reconciliation replay | missing alerts created once; no charge/refund replay |
| `AC-007` | migration/reader regression and repository gate | old notification kinds still parse; `make verify` passes |
