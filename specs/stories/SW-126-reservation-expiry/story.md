# Story: SW-126 Reservation Expiry

## Goal

Expire overdue pending-payment Reservations and release their Room Nights.

## Context

B08 adds the Reservation-owned deadline transition before payment retry and callback flows.

## Classification

* Security sensitive: no
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
* Reason: scheduled state transition and allocation release

## Scope

### In Scope

* Add Reservation expiry command/job and transition evidence in `packages/booking/reservation`.

### Out of Scope

* Payment Attempt behavior, notifications, cancellation, and Availability implementation.

## Inputs

* Current time, Reservation expiry deadline, Reservation state, and Availability release capability.

## Outputs

* Expired Reservation and released Room Nights, or a no-op result.

## Rules

* R1: Only overdue `pending_payment` Reservations can transition to `expired`.
* R2: Lock Reservation first; release Room Nights last in the same transaction.
* R3: Each expiry job carries the exact expected deadline and compares it to the locked Reservation row. A renewed/non-overdue deadline makes stale work a no-op; a deadline extension must replace the Reservation's pending expiry job in the same transaction and never double-release. Deadline extension is owned by the deferred callback lifecycle, not assumed absent here.

## Expected Errors

* Reject/ignore non-expirable states and stale job work without altering state or supply.

## Dependencies

* SW-125 Create Reservation.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Use real PostgreSQL integration for state/locking behavior; no payment callback implementation.
