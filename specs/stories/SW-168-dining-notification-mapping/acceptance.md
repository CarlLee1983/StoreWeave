# SW-168 Acceptance

## Criteria

- [ ] AC-001: Receipt, acceptance, rejection, and cancellation use the same number and appropriate customer-visible details.
- [ ] AC-002: Acceptance email includes date, start, party size, and number but no internal table type.
- [ ] AC-003: Mail failure or unknown delivery does not undo request/decision/capacity state; failed is retryable and unknown waits for deliberate authorized resend.
- [ ] AC-004: Manual resend requires Dining reservation-processing permission and passes actor through Base Notification; a mail-only operator without that permission is denied, while Notification/Mail evidence remains consistent.

## Evidence to collect

Notification contract tests and PostgreSQL outbox/delivery-failure tests; customer template assertions. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
