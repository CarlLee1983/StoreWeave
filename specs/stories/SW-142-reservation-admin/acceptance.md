# Acceptance Criteria

## Happy Path

* [ ] AC-001: Authorized operator can list/detail Reservations, whole-cancel with reason/refund amount, and see payment/refund/notification evidence.

## Business Rules

* [ ] AC-002: Operator refund amount is zero through amount received, audit reason is mandatory, and refund failure never restores Reservation or Room Nights.
* [ ] AC-003: Late/Excess Payment, refund failure, and notification failure are operator-visible with correlation evidence.

## Failure Cases

* [ ] AC-004: Forbidden actor, missing Reservation, invalid amount/reason, state conflict, and unavailable refund action are safely rejected.

## Regression Requirements

* [ ] AC-005: Credentials/unnecessary PII are redacted and browser Admin code imports no provider/DB implementation.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | admin integration test | Reservation Admin suite | authorized operator + Reservation fixtures | routes/actions use declared capabilities |
| `AC-002` | integration test | cancellation/refund failure fixtures | received-payment Reservation | valid audit/refund dispatch; no state restoration |
| `AC-003` | admin integration test | operations evidence views | late/excess/refund/notification fixtures | visible correlated evidence |
| `AC-004` | integration test | invalid operator action matrix | forbidden/missing/conflict inputs | safe distinct outcome |
| `AC-005` | snapshot/import test | detail response and Admin target scan | populated sensitive fixtures | redaction and no forbidden import |
