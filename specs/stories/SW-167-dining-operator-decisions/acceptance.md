# SW-167 Acceptance

## Criteria

- [x] AC-001: Acceptance before start creates one accepted reservation under the same number and occupies capacity; parallel accept cannot oversell.
- [x] AC-002: Closed or full starts and starts already begun leave the request pending with no partial hold.
- [x] AC-003: Rejection remains available after the planned start; pre-start cancellation releases capacity, while post-start cancellation fails.
- [x] AC-004: Reject reason is optional, cancellation reason required; authorized decisions have actor/time/result audit and unauthorized calls change nothing.

## Evidence to collect

PostgreSQL transition, authorization, concurrency, and audit tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.

## Migration and rollback

Migration `0004_operator_decisions` keeps earlier request numbers and capacity commitments. Operator reads resolve the decision from rejection, acceptance and cancellation timestamps. A public submission retry continues to return the original receipt. Once migration 0004 is applied, recover by rolling forward. The pre-167 build lacks 0004 in its migration catalog and fails normal release activation. Its operator reader would also report pending for decided requests. A rollback build would need a compatible catalog and lifecycle reader, with its own verification.

## Implementation evidence (2026-11-23)

The Command Bus and PostgreSQL tests in [dining-operator-decisions.test.ts](../../../tests/integration/dining-operator-decisions.test.ts) exercise all four criteria. The four Dining integration files passed 21/21 focused tests, including 10 SW-167 cases.

| Criterion | Observed evidence |
| --- | --- |
| AC-001 | Two operators competing for one table yield one acceptance. Acceptance and rejection of the same request yield one decision and one audit entry. Acceptance retains the public number and allocates over the saved interval. |
| AC-002 | Closing the start or exhausting capacity leaves the request pending. A capacity write blocked in PostgreSQL until the start fails and preserves the prior state. |
| AC-003 | An expired pending request can be rejected. A pre-start cancellation frees capacity for a waiting request. A cancellation that waits past the start preserves the commitment. |
| AC-004 | Visitor commands are denied, including an attempt to replay a manager’s receipt. The audit projection contains the authenticated actor, decision time and outcome. Rejection accepts an omitted reason and cancellation requires a nonblank reason. |
