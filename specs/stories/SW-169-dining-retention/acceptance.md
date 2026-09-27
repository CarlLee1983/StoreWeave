# SW-169 Acceptance

## Criteria

- [ ] AC-001: Each lifecycle uses its specified cutoff; a pending request past planned end can be anonymized without auto-rejection.
- [ ] AC-002: At cutoff, Dining fields, free text, jobs, and audit contain no customer identifiers; Base Notification/Mail erase succeeds through owned capabilities.
- [ ] AC-003: Pending, failed, or unknown mail cannot send after cutoff; repeated jobs are safe.
- [ ] AC-004: An anonymized pending request can later be rejected without email. A supplied free-text rejection reason is discarded and does not repopulate Dining, job, or audit data; sanitized actor/time/result audit remains.
- [ ] AC-005: Timezone remains immutable after requests exist, so stored cutoff interpretation cannot drift.

## Evidence to collect

PostgreSQL lifecycle/cutoff and send/erase race tests, including late rejection. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
