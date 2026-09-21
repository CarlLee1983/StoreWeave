# Story: SW-148 Property-Locked Quote Facts

## Goal

Expose active Property and Room Type facts under owner-controlled row locks for Availability's atomic Quote revalidation.

## Context

SW-125 needs Property policy and Room Type limits to remain stable while Availability rechecks Quote terms and reserves Room Nights. Availability must not read or lock Property-owned tables directly.

## Classification

* Security sensitive: no
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
* Reason: transaction lock order for persistent booking allocation

## Scope

### In Scope

* Extend the Property-owned `booking.property.read.v1` capability with `requireLockedQuoteFacts(tx, roomTypeId)` in `packages/booking/property`.
* Return only the Property policy/currency/timezone/check-in facts and active Room Type occupancy/stay facts Availability needs.
* Lock the Property singleton first, then the requested Room Type, retaining both locks in the caller's transaction.
* Add PostgreSQL lock-order and transaction-lifetime evidence in `tests/integration/booking-property.test.ts`.

### Out of Scope

* Availability reads, Quote calculation, Room Night changes, Reservation persistence, schema changes, and new capability identifiers.

## Inputs

* Caller-owned database transaction and Room Type UUID.

## Outputs

* The Property Quote facts and active Room Type Quote facts from rows locked in the caller's transaction.

## Rules

* R1: Property owns all reads and locks on its tables; consumers receive facts only through the capability.
* R2: Lock the Property singleton before the active Room Type so the lock order is stable and documented.
* R3: The operation requires an existing Property and active Room Type; it does not create, update, or commit data.
* R4: Return a narrow immutable data shape containing only fields used by Quote calculation and validation.

## Expected Errors

* Missing Property is a recognizable conflict. Missing or inactive Room Type is a not-found error. Invalid UUID input is rejected before database access.

## Dependencies

* SW-119 Property and Room Type.

## Constraints

* Implementation boundary: `packages/booking/property` only. The existing integration suite provides PostgreSQL evidence; no migration or consumer changes. Requires Sol/high design analysis and independent Sol/high review because the method establishes a cross-module lock-order contract.
