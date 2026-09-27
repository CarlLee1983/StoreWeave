# SW-166 Acceptance

## Criteria

- [ ] AC-001: Only starts with a fitting available table type may be submitted; pending requests do not consume capacity.
- [ ] AC-002: The same submission key creates exactly one pending request and number under concurrent retry; a distinct key may create another request.
- [ ] AC-003: Invalid contact/party/start/window input or either rate limit creates no request and schedules no receipt.
- [ ] AC-004: Stored optional notes are shown verbatim to authorized operators and do not alter table selection.
- [ ] AC-005: Rate-limit data expires without retaining recipient identifiers beyond Dining retention.
- [ ] AC-006: Party size is the total number of people requiring seats, including infants needing high chairs; no adult/child allocation or joined tables are inferred.

## Evidence to collect

PostgreSQL idempotency/rate-limit tests and available-start boundary tests; source identity is a trusted contract input. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
