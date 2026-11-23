# SW-168 Acceptance

## Criteria

- [x] AC-001: Receipt, acceptance, rejection, and cancellation use the same number and appropriate customer-visible details.
- [x] AC-002: Acceptance email includes date, start, party size, and number but no internal table type.
- [x] AC-003: Mail failure or unknown delivery does not undo request/decision/capacity state; failed is retryable and unknown waits for deliberate authorized resend.
- [x] AC-004: Manual resend requires Dining reservation-processing permission and passes actor through Base Notification; a mail-only operator without that permission is denied, while Notification/Mail evidence remains consistent.

## Evidence to collect

Notification contract tests and PostgreSQL outbox/delivery-failure tests; customer template assertions. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.

## Implementation evidence (2026-11-23)

| Criterion | Observed result |
| --- | --- |
| AC-001 | PostgreSQL and SMTP tests deliver all four lifecycle messages. They keep the number returned at submission. A repeated submission or decision does not send an additional email. Rejection supports a generic message or the operator's reason, and cancellation includes the customer-facing reason. |
| AC-002 | The rendered acceptance text and HTML contain the request's local date, start, party size, and number. The assigned table type and private request note are absent. |
| AC-003 | A simulated Notification write outage leaves the request, decision, and capacity committed. Replaying the queued work after recovery sends one email per event. Confirmed SMTP rejection stays retryable. Replaying an ordinary delivery job for an uncertain outcome makes no further SMTP attempt. |
| AC-004 | A reservation-processing operator can read delivery status and request an explicit resend. A mail-only operator is denied via both Dining and Base. The original receipt reference remains usable. Wrong event, stale attempt count, and missing risk acknowledgment are rejected. Replaying the same authorized operation returns its receipt, and Mail, Notification, and the operator audit agree on the result. |

The [lifecycle tests](../../../tests/integration/dining-notification-mapping.test.ts) exercise the durable job and rendered mail. The [operator tests](../../../tests/integration/dining-notification-resend.test.ts) cover processing permission, the Base entry point, and resend evidence. The [contract tests](../../../packages/dining/reservation/test/operator-notifications.test.ts) verify the query and command shapes.

The Dining transaction enqueues only the opaque request ID and lifecycle event. The worker materializes the email through Base Notification after commit. The release composition passes the owning module's declared resend permission to Base. Base validates the persisted reference under the delivery lock. Existing unowned references continue to use the standard Base resend permission.

Roll out workers that recognize the new Dining notification job before enabling updated Dining command handlers. Drain outstanding notification jobs before removing that worker version. This Story adds no database migration.

Final `make verify` exited 0 with backend and admin typechecks passing, 1,611 unit tests, 351 admin tests and 1,109 PostgreSQL integration tests. The unchanged baseline at `77db4b1` also passed (1,609 unit, 351 admin and 1,103 integration tests). `git diff --check` passed.
