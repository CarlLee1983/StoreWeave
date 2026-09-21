# Story: SW-127 Reservation Payment Attempts

## Goal

Create idempotent Reservation Payment Attempts and permit safe retry after terminal failure or expiry.

## Context

B09 gives Booking its own payment-attempt lifecycle after the domain-neutral Provider ABI is complete.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes, Booking database only
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: money movement and idempotency

## Scope

### In Scope

* Add Reservation Payment Attempt persistence, `created`/`submitted`/`awaiting_payment` lifecycle, synchronous `failed` result handling, start command, Provider invocation contract use, Attempt expiry, and retry rules in `packages/booking/reservation`.

### Out of Scope

* Provider ABI/adapters, asynchronous callback outcome mapping, winning selection, deferred deadline extension, refunds, cancellation, and HTTP endpoints.

## Inputs

* Valid `pending_payment` Reservation, idempotency operation, method, and domain-neutral Provider capability.

## Outputs

* One uniquely referenced Attempt in `created`, `submitted`, or `awaiting_payment`, with method and expiry.

## Rules

* R1: Same operation retry returns the same Attempt.
* R2: A new Attempt is allowed only after the prior Attempt is explicitly `failed` or `expired` and Reservation remains valid.
* R3: An active `submitted` or `awaiting_payment` Attempt blocks parallel creation.
* R4: This Story owns only synchronous `failed` results and expiry/retry eligibility. SW-128 maps verified callback outcomes `payment_confirmed` to `succeeded`, `payment_info_issued` to non-terminal `awaiting_payment`, and `payment_failed` to `failed`.

## Expected Errors

* Reject invalid Reservation state/method, duplicate active attempt, and Provider setup failure without ambiguous retry state.

## Dependencies

* SW-118 Payment ABI contract.
* SW-125 Create Reservation.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. The Provider receives only reference, displayReference, amount, currency, and method.
