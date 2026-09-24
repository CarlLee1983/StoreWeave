# Story: SW-123 Atomic Room Night Operations

## Goal

Provide transaction-safe, fixed-order Room Night reserve and release operations.

## Context

B05 makes Availability safe for Reservation callers without granting Reservation direct access to Availability tables.

## Classification

* Security sensitive: no
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: concurrent stock allocation

## Scope

### In Scope

* Add the `booking.availability.room-night-operations.v1` Availability capability for atomic multi-night reservation and release in `packages/booking/availability`.

### Out of Scope

* Reservation state transitions, payment, Quote UI, and direct foreign-table writes.

## Inputs

* Room Type, contiguous local-date range, requested room count, and transaction context.

## Outputs

* `reserve(tx, input, now)` returns `{ kind: 'reserved' }` or `{ kind: 'unavailable' }`; `release(tx, input, now)` returns `{ kind: 'released' }`.

## Rules

* R1: `reserve` materializes missing Room Nights and locks the requested rows in ascending local-date order; `release` locks existing rows in the same order and never materializes missing rows.
* R2: `reserve` preflights every requested night and increments none unless every night has enough available units. An unavailable result may leave newly materialized zero-sellable rows, but never changes reserved counts.
* R3: `release` preflights every requested night and decrements none unless every night has enough reserved units; it never makes reserved units negative.
* R4: The caller owns the transaction and retains locks until commit or rollback. The capability validates supply only; Quote terms and Property facts remain outside this story.

## Expected Errors

* Reject malformed UUIDs, dates, ranges, counts, and clocks before database access. Return unavailable for any insufficient reserve night. Raise a recognizable conflict for a missing or underflowing release range.

## Dependencies

* SW-122 Availability Quote.

## Constraints

* Boundary: `packages/booking/availability` only. Requires Sol/high design analysis and independent Sol/high review before implementation; verify with real PostgreSQL concurrency.
