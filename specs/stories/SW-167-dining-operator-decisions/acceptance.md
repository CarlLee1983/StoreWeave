# SW-167 Acceptance

## Criteria

- [ ] AC-001: Acceptance before start creates one accepted reservation under the same number and occupies capacity; parallel accept cannot oversell.
- [ ] AC-002: Closed or full starts and starts already begun leave the request pending with no partial hold.
- [ ] AC-003: Rejection remains available after the planned start; pre-start cancellation releases capacity, while post-start cancellation fails.
- [ ] AC-004: Reject reason is optional, cancellation reason required; authorized decisions have actor/time/result audit and unauthorized calls change nothing.

## Evidence to collect

PostgreSQL transition, authorization, concurrency, and audit tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
