# Story: SW-128 Payment Callback Winner

## Goal

Apply verified payment callbacks with one winning Attempt and correct Late/Excess outcomes.

## Context

B10 serializes callback effects against Reservation lifecycle work.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes, Booking database only if needed
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: payment callback races and financial correctness

## Scope

### In Scope

* Add verified callback outcome mapping (`payment_confirmed` → `succeeded`, `payment_info_issued` → non-terminal `awaiting_payment`, `payment_failed` → `failed`), deferred payment deadline extension, winning Attempt selection, callback/expiry/cancel race serialization, and Late/Excess recording in `packages/booking/reservation`.

### Out of Scope

* Provider callback verification implementation, refund execution, notification delivery, and independent expiry/cancel feature changes.

## Inputs

* Verified Provider outcome keyed by unique reference, current Reservation/Attempt state, and transaction context.

## Outputs

* Confirmed Reservation with `winning_payment_attempt_id`, or durable Late/Excess payment evidence for refund processing.

## Rules

* R1: Lock Reservation, then relevant Attempts in fixed order, then Room Nights only when needed.
* R2: First applicable success confirms; callback replay is idempotent.
* R3: Success after expiry/cancellation is Late Payment; later success after confirmation is Excess Payment; neither changes occupancy/state.
* R4: A verified deferred callback may extend its payment deadline while holding the Reservation lock; an expiry/cancel/callback race rechecks current state and produces one serializable result.
* R5: Attempt states are only `created`, `submitted`, `awaiting_payment`, `succeeded`, `failed`, and `expired`; `payment_info_issued` is a Provider callback outcome, not a terminal Attempt state.

## Expected Errors

* Reject unknown/unverified references and preserve state for stale or inapplicable callbacks.

## Dependencies

* SW-126 Reservation Expiry.
* SW-127 Reservation Payment Attempts.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Verify with real PostgreSQL callback/expiry/cancel race tests.
