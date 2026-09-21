# Story: SW-149 Atomic Quote Revalidation and Room Night Reservation

## Goal

Revalidate a signed Booking Quote and reserve its Room Nights atomically through an Availability-owned transaction capability.

## Context

SW-123 protects supply but does not revalidate price, Property policy, or Room Type rules. SW-125 needs an exact-match operation that keeps the Reservation package isolated from Availability tables. This story completes the prerequisite in ticket 105 and blocks SW-125 until accepted.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Risk

* Level: high
* Reason: signed price integrity, persistent allocation, and concurrent transactions

## Scope

### In Scope

* Add `booking.availability.quote-reservation.v1` in `packages/booking/availability`.
* Export an explicit capability binder so the composition root can pass the Availability-owned service to Reservation with its Property, Quote-limit, and signing-key dependencies already configured.
* Recompute and authenticate the Quote from current owner facts and locked Availability rows inside the caller's transaction.
* Reserve all requested Room Nights only when the submitted Quote fingerprint exactly authenticates the current terms.

### Out of Scope

* Reservation persistence or callbacks, payment, HTTP, Theme, Property table access, migrations, and changes to the supply-only SW-123 capability.

## Inputs

* Caller-owned transaction, validated Quote request, expected Quote fingerprint, and current time.

## Outputs

* `reserved` with the exact current Quote, `stale` with a replacement Quote, or `unavailable` without partial reservation.

## Rules

* R1: Validate caller-only syntax, static stay limits, room-count cap, and fingerprint syntax before database access. Use the required Booking configuration option for the maximum room count; add no guessed default.
* R2: Obtain locked Property/Room Type facts from the Property capability, validate Property-local horizon and Room Type occupancy/stay rules, then access Availability-owned rows.
* R3: Lock in this order: Property singleton, active Room Type, base-price row, materialize missing Room Nights in ascending local-date order, then lock Room Nights in ascending local-date order.
* R4: Build current Quote terms from those locked rows. Matching fingerprints reserve every night in the same transaction and return the exact Quote; a syntactically valid fingerprint that is changed, tampered, or unverifiable returns a replacement Quote without reserving.
* R5: Any still-configured signing key can authenticate its original fingerprint; returned Quotes use the active key. Compare MACs in constant time. Unknown or removed keys cannot reserve.
* R6: Insufficient supply returns `unavailable` and changes no reserved units. Availability neither commits nor persists Reservation data; the caller retains the transaction and locks.

## Expected Errors

* Preserve existing validation, conflict, and not-found errors for invalid booking requests or missing owner facts. An invalid fingerprint syntax is a validation error before I/O; a valid request with insufficient supply is `unavailable`; a syntactically valid fingerprint that does not authenticate current terms is `stale` with a replacement Quote.

## Dependencies

* SW-122 Availability Quote.
* SW-123 Atomic Room Night Operations.
* SW-148 Property-Locked Quote Facts.

## Constraints

* Implementation boundary: `packages/booking/availability` only; PostgreSQL and architecture evidence may live in `tests/integration` and `tests/architecture`. No Reservation, Property-table, or payment imports. SW-125 remains confined to `packages/booking/reservation` and may proceed only after this story passes. Requires Sol/high design analysis and independent Sol/high review. Verification includes real PostgreSQL concurrency tests and `make verify`.
