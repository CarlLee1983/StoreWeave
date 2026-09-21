# Story: SW-122 Availability Quote

## Goal

Calculate a non-persistent Booking Quote from Room Night supply, nightly price, occupancy, and policy.

## Context

B04 provides the Availability capability consumed by a later storefront and Reservation creation flow.

## Classification

* Security sensitive: yes
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
* Reason: public price Quote and cryptographic integrity contract

## Scope

### In Scope

* Add Quote calculation and validation capability in `packages/booking/availability`.

### Out of Scope

* Storefront renderer, Reservation persistence, Room Night mutation, payment, and policy editing.

## Inputs

* Room Type facts, Availability-owned base nightly price and local-date override, Property timezone/currency/check-in time/policy, requested stay, adults, children, room count, Room Nights, and the configured signing Keyring.
* Required `maxRoomsPerRequest` supplied to the Availability module at construction; SW-138 wires it from `booking.yaml`.

## Outputs

* Either an unavailable result, or a deterministic Quote with each inclusive-tax per-room nightly price, each requested-room nightly total, currency, total, a Cancellation Policy snapshot, and a server-authenticated fingerprint.

## Rules

* R1: Check-in is inclusive and check-out exclusive.
* R2: Quote does not reserve supply or promise price.
* R3: Every requested room needs an adult; total guests cannot exceed room count times occupancy.
* R4: Use the Availability-owned base nightly price when no local-date override exists.
* R5: Before I/O, reject malformed/non-canonical dates, invalid counts, reversed or overlong ranges, room counts above the required configured cap, and requests with fewer adults than rooms. Then read Property and active Room Type facts through the declared capability; reject check-in dates before Property-local today or after Property-local today plus 365 days (inclusive), Room Type stay-limit violations, and occupancy violations before querying Availability tables. Checkout is exclusive and remains bounded by the 30-night stay limit.
* R6: Quote is a read-only, non-locking operation. It reads price and supply in one Availability-owned statement; missing or insufficient Room Nights return an unavailable result.
* R7: Fingerprint is a versioned HMAC-SHA-256 over canonical JSON for request terms, currency, ascending nightly prices and available-unit snapshot, total, and the Cancellation Policy snapshot. Derive its signing key from the configured Keyring with purpose `booking-quote`; include the active key id in the fingerprint. It excludes time/randomness, is recomputed by the server, and is not authorization or a price promise. Do not expose raw supply counts or signing material in the public Quote.
* R8: The required room-count cap has no package default; Availability construction fails unless a valid positive `maxRoomsPerRequest` is injected. Product Release configuration provides its value.
* R9: Availability construction requires the configured signing Keyring. Product Release wiring supplies it from the existing security signing-key configuration; missing signing-key configuration remains a startup/configuration error.

## Expected Errors

* Reject caller-only malformed/invalid request input before any database query. Reject Property/RoomType-dependent horizon, stay-limit, and occupancy errors after owner-fact reads but before any Availability-table query or lock. An unconfigured Property or missing base price is a configuration conflict; a missing/inactive Room Type is not found. Missing or insufficient Room Nights are an unavailable result. Unavailable Quotes are read-only and never mutate supply.

## Dependencies

* SW-121 Room Night Administration.

## Constraints

* Boundary: `packages/booking/availability` only. Its public Quote Query and reusable `booking.availability.quote.v1` capability share one implementation accepting the caller's `DrizzleDb | Tx` and clock, so Reservation can re-quote in its transaction. Requires Sol/high design analysis and independent Sol/high review for this public price/Quote contract. Use integer minor units, one Property currency, no service fee, and no persistent Quote table. The configured room-count cap and signing Keyring are injected now; Booking Release wiring remains SW-138.
