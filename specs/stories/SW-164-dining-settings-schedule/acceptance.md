# SW-164 Acceptance

## Criteria

- [ ] AC-001: Duplicate table types with the same seat capacity are rejected; settings persist and can be read.
- [ ] AC-002: A date override fully replaces weekly starts for its start date, including a closed date.
- [ ] AC-003: Nonexistent and ambiguous local DST starts are unavailable; cross-midnight starts belong to their start date.
- [ ] AC-004: Once a request exists, timezone edits fail; later duration/window changes do not rewrite existing request snapshots.
- [ ] AC-005: Setting changes record actor, time, and result without customer contact fields.
- [ ] AC-006: The default booking window is at least one hour and at most thirty days before the start; authorized settings may change both bounds for future requests.

## Evidence to collect

Unit timezone/schedule tests plus PostgreSQL command and snapshot tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
