# SW-173 Acceptance

## Criteria

- [ ] AC-001: Public invalid/limited submission creates no request or receipt; stable retries return one number.
- [ ] AC-002: Source identity cannot be selected by the caller through an untrusted field or raw forwarded header.
- [ ] AC-003: Operator routes enforce roles and expose list, settings, decision, and resend outcomes; unauthorized calls change no state.
- [ ] AC-004: Routes call module capabilities only and do not expose customer PII through replay/audit payloads.

## Evidence to collect

HTTP contract and authorization tests with trusted/untrusted source fixtures. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
