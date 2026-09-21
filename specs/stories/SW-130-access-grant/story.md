# Story: SW-130 Reservation Access Grant

## Goal

Give an anonymous Booker a one-time, short-lived Access Grant that safely establishes Reservation management state.

## Context

B12 introduces anonymous management without treating Reservation number plus Email as authorization.

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
* Reason: bearer credential lifecycle

## Scope

### In Scope

* Add Access Grant issuance/reissue, redemption, management-token hashing, revocation generation, and Reservation management authorization in `packages/booking/reservation`.

### Out of Scope

* HTTP cookie/303 adapter behavior, email delivery, Account claim, cancellation, and Base Notification delivery.

## Inputs

* Reservation identity, signing configuration, grant nonce/generation/expiry, and management-token authorization request.

## Outputs

* Short-lived single-use signed Grant and revocable hashed management-token session material.

## Rules

* R1: Grant validates signature, purpose, expiry, generation, and unused nonce, then may be redeemed exactly once.
* R2: A raw management token is random and only its hash persists; reissue increments generation and revokes earlier Grants/tokens.
* R3: Grant grants redemption only; it cannot directly read, update, or cancel a Reservation.

## Expected Errors

* Reject expired, replayed, wrong-purpose, tampered, superseded, and missing management credentials.

## Dependencies

* SW-125 Create Reservation.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Raw management token must never enter DB, logs, URL, or notification payload; HTTP secure-cookie and clean-URL proof belongs to a later adapter Story.
* Access operations accept the caller's transaction. Grant redemption is a direct pre-Actor service call, not a Command: CommandBus may persist raw command responses for idempotency. Grant TTL is caller-supplied and bounded to 1–60 minutes; no implicit duration is chosen.
