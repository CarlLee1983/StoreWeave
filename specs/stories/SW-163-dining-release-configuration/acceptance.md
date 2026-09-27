# SW-163 Acceptance

## Criteria

- [ ] AC-001: Missing, zero, negative, fractional, or invalid retention days fails configuration validation.
- [ ] AC-002: Both source and recipient limits and windows are required positive integers; absent or invalid values prevent the public request entrance from starting.
- [ ] AC-003: A valid configuration is available to Dining without an implicit retention value; existing release configuration remains unaffected.

## Evidence to collect

Configuration unit tests and package resolution/type checks; no live public endpoint is required in this Story. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
