# Story: SW-125 Create Reservation

## Goal

Create a pending-payment Reservation from a current Booking Quote while atomically occupying Room Nights.

## Context

B07 begins the Reservation aggregate; it consumes Availability only through its declared capability.

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
* Reason: durable commitment and concurrent allocation

## Scope

### In Scope

* Add Reservation, Booker/Guest snapshot, frozen quote terms, and create command in `packages/booking/reservation`.
* Register the new workspace package with the Dockerfile package manifest copy, pnpm lockfile importer, and root TypeScript alias.

### Out of Scope

* Payment attempts, Access Grant, cancellation, HTTP, Theme, and Availability implementation changes.

## Inputs

* Current Quote fingerprint, Booker name/email/phone, primary Guest name, adult/child counts, optional accommodation notes, and the Availability capability.
* The first version stores only the primary Guest name and party counts; it does not collect a full guest list or identity documents.

## Outputs

* A `pending_payment` Reservation with frozen nightly prices, currency, total, policy, payment deadline, and occupied Room Nights; or a replacement Quote / unavailable result when the submitted Quote is no longer current.

## Rules

* R1: Recheck supply, price, and policy in one transaction; exact match creates the Reservation.
* R2: Changed terms return a replacement Quote; unavailable terms create nothing.
* R3: Date, Room Type, and room count are immutable after creation; Booker need not be logged in.
* R4: A normally created `pending_payment` Reservation receives the Booking default 15-minute payment deadline.
* R5: The create command uses a required idempotency key and its response/audit payload never includes Booker contact fields.

## Expected Errors

* Return stale-quote and unavailable outcomes without a Reservation or Room Night hold. Reject invalid Booker/Guest fields, dates, room count, and occupancy without durable partial state.

## Dependencies

* SW-123 Atomic Room Night Operations.

## Constraints

* Boundary: `packages/booking/reservation` plus the three minimum workspace registrations listed above, with acceptance tests in the existing test directories. Refresh the B17 semantic ledger's dependency-lock fingerprint and SW-102's B17 public-contract input fingerprint when the lockfile-derived artifact changes; these are derived verification metadata and do not change Commerce behavior. No `pnpm-workspace.yaml` edit is needed because its `packages/booking/*` glob already includes this package. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Reservation never writes Availability tables directly.

## Scope Decision

The story was explicitly expanded to include the three minimum workspace registrations because `packages/booking/reservation` did not yet exist and could not be built or type-resolved without them.
