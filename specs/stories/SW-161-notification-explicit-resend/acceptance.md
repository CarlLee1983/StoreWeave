# SW-161 Acceptance

## Criteria

- [x] AC-001: Failed delivery can be retried and an unknown outcome is never automatically resent.
- [x] AC-002: An authorized operator explicitly resends unknown mail after acknowledging duplicate-delivery risk; an unauthorized call changes nothing.
- [x] AC-003: After any manual attempt, Notification and Mail evidence agree and an audit record identifies actor, time, and outcome.
- [x] AC-004: Base, Commerce, and Booking Notification flows retain their existing behavior.

## Evidence to collect

Contract and integration tests over Notification plus Mail attempts; existing product regression tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.

## Implementation evidence (2026-11-23)

The [Notification integration tests](../../../tests/integration/notifications.test.ts) run the Command Bus, worker, PostgreSQL, and an SMTP test server. The [Notification contract tests](../../../packages/platform/notifications/test/contract.test.ts) cover the public request schema.

| Criterion | Observed evidence |
| --- | --- |
| AC-001 | Two concurrent operator decisions on the same rejection queue one attempt. A second rejection permits a fresh retry. Requeuing an unknown delivery makes no SMTP call, including when the Mail row is missing or independently marked rejected. |
| AC-002 | A user with `notifications:resend` can request an unknown resend after acknowledging duplicate-delivery risk. Missing acknowledgment or permission leaves delivery and audit evidence untouched. A product command calling the port enforces the same operator policy. |
| AC-003 | A confirmed manual send records Notification `sent` and Mail `accepted` with the same attempt count. The audit identifies the operator, operation, time, and outcome. Retrying after a post-SMTP transaction rollback reconciles the claim to `unknown` without another SMTP call. Erasure before the claim records a skipped operation. Legacy attempt counts converge on the Mail count after a manual attempt. |
| AC-004 | Base Notification, Commerce lifecycle, and Booking reservation regression tests passed in the full suite. Release adoption and upgrade tests preserve existing delivery and migration rows. |

Review identified two cases now covered by regression tests. The operator check applies before Command Bus returns a cached receipt. The automatic worker also checks the Notification status before preparing Mail, so missing or stale Mail evidence cannot trigger a resend of an unknown delivery.

Migration `0002_email_resends` adds the durable operation record and permits one open operation per delivery. Upgrade the API and workers together before enabling manual resend. Older workers do not check for manual operations. Keep the migration and queued operations when rolling forward.

Final `make verify` exited 0 on the reviewed worktree. Backend and admin typechecks passed, with 1,609 unit tests, 351 admin tests and 1,103 integration tests passing. The unchanged baseline at `3095047` also passed (1,608 unit, 351 admin and 1,095 integration). `git diff --check` passed.
