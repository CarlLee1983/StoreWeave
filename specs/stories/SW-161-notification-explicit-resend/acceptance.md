# SW-161 Acceptance

## Criteria

- [ ] AC-001: Failed delivery can be retried and an unknown outcome is never automatically resent.
- [ ] AC-002: An authorized operator explicitly resends unknown mail after acknowledging duplicate-delivery risk; an unauthorized call changes nothing.
- [ ] AC-003: After any manual attempt, Notification and Mail evidence agree and an audit record identifies actor, time, and outcome.
- [ ] AC-004: Base, Commerce, and Booking Notification flows retain their existing behavior.

## Evidence to collect

Contract and integration tests over Notification plus Mail attempts; existing product regression tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
