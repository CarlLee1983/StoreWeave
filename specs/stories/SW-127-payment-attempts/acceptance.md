# Acceptance Criteria

## Happy Path

* [ ] AC-001: Starting payment creates one uniquely referenced `created`, `submitted`, or `awaiting_payment` Attempt for a valid pending Reservation, and records a synchronous `failed` result when applicable.

## Business Rules

* [ ] AC-002: Replaying the same operation returns that Attempt; expiry and synchronous `failed` results make a new reference eligible for retry.
* [ ] AC-003: Active submitted/awaiting attempts block parallel retries.

## Failure Cases

* [ ] AC-004: Invalid state/method or Provider failure leaves no ambiguous duplicate Attempt; asynchronous callback mapping of `payment_confirmed` to `succeeded`, `payment_info_issued` to non-terminal `awaiting_payment`, and `payment_failed` to `failed` is not implemented here.

## Regression Requirements

* [ ] AC-005: Provider calls use only the domain-neutral ABI and do not import Commerce Order behavior.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | start-payment test | valid pending Reservation | one allowed lifecycle Attempt and Provider request |
| `AC-002` | integration | idempotency/expiry/retry test | repeated, synchronous-failed, and expired Attempt fixtures | same or new reference as required |
| `AC-003` | integration | concurrent active-attempt test | active Attempt | recognizable blocked retry |
| `AC-004` | integration | invalid/Provider failure test | failure fixtures | no ambiguous persistence |
| `AC-005` | contract | Provider request and import test | mock Provider | neutral fields only |
