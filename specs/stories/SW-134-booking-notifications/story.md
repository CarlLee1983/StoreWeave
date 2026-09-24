# Story: SW-134 Booking Notifications

## Goal

Map Reservation events to Booking notification content while preserving durable delivery failures for operators.

## Context

B16 finishes Reservation-owned communication mapping; Base Notification remains the delivery mechanism.

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

* Level: medium
* Reason: notification security and operational visibility

## Scope

### In Scope

* Add Booking event-to-template mapping, content inputs, and operator-visible notification failure linkage in `packages/booking/reservation`.

### Out of Scope

* Base Notification durable delivery/retry/provider adapter implementation, SMTP, HTTP management redemption, and Theme rendering.

## Inputs

* Reservation confirmed/cancelled/payment-expiring events, Booker snapshot, issued Access Grant payload, and Base Notification capability.

## Outputs

* Durable Booking notification requests for required templates and queryable delivery/failure evidence.

## Rules

* R1: Booking owns event mapping, template selection, and wording; Base owns queueing, send, retry, and delivery log.
* R2: Notification failure never rolls back Reservation state.
* R3: Email contains a short-lived Access Grant, never a raw management token; raw token is absent from URL, notification, DB, and logs.

## Expected Errors

* Record malformed mapping/delivery failure as observable operational evidence; never silently discard it.

## Dependencies

* SW-128 Payment Callback Winner.
* SW-129 Reservation Refunds.
* SW-130 Reservation Access Grant.
* SW-133 Reservation Cancellation.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Real SMTP and external provider UAT remain release gates; this Story does not modify Base Notification.
