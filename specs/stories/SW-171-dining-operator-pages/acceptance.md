# SW-171 Acceptance

## Criteria

- [ ] AC-001: Authorized operators can list each required lifecycle state and see notification status; accepted list filters by date.
- [ ] AC-002: Accept/reject/cancel/settings/resend actions invoke owned commands and show business errors without overriding constraints.
- [ ] AC-003: Unknown delivery is marked for manual confirmation; erasure disables resend and shows the cannot-notify state.
- [ ] AC-004: Permissions hide/deny unauthorized actions; manual resend specifically requires Dining reservation-processing permission, and allowed actions audit actor, time, and result.
- [ ] AC-005: Authorized operators see an applicant's optional note as submitted, without treating it as a guaranteed accommodation or automatic allocation rule.

## Evidence to collect

Admin declaration/UI tests plus authorized/unauthorized command wiring tests. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
