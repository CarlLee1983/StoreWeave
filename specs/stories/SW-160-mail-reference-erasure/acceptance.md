# SW-160 Acceptance

## Criteria

- [ ] AC-001: A reference-scoped erase removes Mail-owned customer identifiers and content while retaining only non-identifying delivery/dedupe evidence.
- [ ] AC-002: A send already queued, claimed, retrying, or unknown cannot emit mail after erase completes, including concurrent send/erase races.
- [ ] AC-003: Repeated erasure is safe; pre-existing Base, Commerce, and Booking mail flows still work.

## Evidence to collect

PostgreSQL race tests for send/erase fencing; Mail contract and regression tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
