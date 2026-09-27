# SW-162 Acceptance

## Criteria

- [ ] AC-001: After erasure completes, Notification and Mail expose no customer identifiers or rendered content for the reference.
- [ ] AC-002: Queued, in-flight, failed, and unknown outcomes cannot send or be manually resent after erasure; a PostgreSQL race between explicit resend and erasure stays fenced.
- [ ] AC-003: Repeated erasure is safe and retained evidence contains no recipient or free text.
- [ ] AC-004: Shared Notification consumers retain prior behavior outside erased references.

## Evidence to collect

PostgreSQL dispatch/erase and resend/erase race tests; Base, Commerce, Booking regression checks. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
