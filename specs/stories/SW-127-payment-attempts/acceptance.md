# Acceptance Criteria

## Happy Path

* [x] AC-001: Starting payment creates one uniquely referenced `created`, `submitted`, or `awaiting_payment` Attempt for a valid pending Reservation, and records a synchronous `failed` result when applicable.

## Business Rules

* [x] AC-002: Replaying the same operation returns that Attempt; expiry and synchronous `failed` results make a new reference eligible for retry.
* [x] AC-003: Active submitted/awaiting attempts block parallel retries.

## Failure Cases

* [x] AC-004: Invalid state/method or Provider failure leaves no ambiguous duplicate Attempt; asynchronous callback mapping of `payment_confirmed` to `succeeded`, `payment_info_issued` to non-terminal `awaiting_payment`, and `payment_failed` to `failed` is not implemented here.

## Regression Requirements

* [x] AC-005: Provider calls use only the domain-neutral ABI and do not import Commerce Order behavior.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration | `booking-reservation.test.ts` start, redirect, awaiting, synchronous-failed, and synchronous-confirmed fixtures | valid pending Reservation | one allowed lifecycle Attempt and Provider request; confirmation evidence retained without confirming Reservation |
| `AC-002` | integration | `booking-reservation.test.ts` idempotency, failed, and expired Attempt fixtures | repeated, synchronous-failed, and expired Attempt fixtures | same or new reference as required |
| `AC-003` | integration | `booking-reservation.test.ts` concurrent active-attempt and transport-uncertain fixtures | active Attempt | recognizable blocked retry |
| `AC-004` | integration | `booking-reservation.test.ts` invalid state, method, Provider setup, expiry/late-confirmation, and Provider-change fixtures | failure fixtures | no ambiguous persistence, late confirmation retained, and no call through a changed Provider |
| `AC-005` | contract | neutral Provider input-key assertion and `booking-reservation-boundaries.test.ts` import scan | fake Provider | only five neutral fields; no Commerce import |
