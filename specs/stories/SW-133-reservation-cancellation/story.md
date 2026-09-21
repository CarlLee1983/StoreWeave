# Story: SW-133 Reservation Cancellation

## Goal

Cancel a Reservation under frozen policy or operator authority, release Room Nights, and enqueue the correct refund.

## Context

B15 closes the Reservation lifecycle with customer and operator cancellation paths.

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
* Reason: state transition, inventory release, and refund amount

## Scope

### In Scope

* Add self-service/operator cancellation commands, policy check, audit reason, release, and refund enqueueing in `packages/booking/reservation`.

### Out of Scope

* Refund Provider execution, partial cancellation, date/Room Type/room-count edits, and HTTP authorization adapter.

## Inputs

* Authorized Booker or operator, Reservation state/frozen Cancellation Policy, requested operator refund amount/reason, and Availability/refund capabilities.

## Outputs

* `cancelled` Reservation, atomic Room Night release, cancellation audit, and eligible refund work.

## Rules

* R1: Booker self-service is whole-Reservation, before policy deadline, and full refund only.
* R2: Operator cancellation is whole-Reservation, requires audit reason, and refund is zero through actual received amount.
* R3: Lock Reservation first and release Room Nights in the same transaction; refund failure never restores Reservation.

## Expected Errors

* Reject unauthorised/late self-service, invalid status, partial edits, missing reason, and out-of-range operator refund.

## Dependencies

* SW-128 Payment Callback Winner.
* SW-129 Reservation Refunds.
* SW-131 Managed Access Claim.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. No direct Availability-table access.
