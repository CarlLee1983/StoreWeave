# Story: SW-119 Property and Room Type

## Goal

Establish Booking Property and Room Type facts for a single-property release.

## Context

B01 starts the Booking domain without reusing Commerce Product, SKU, Customer, or Inventory semantics.

## Classification

* Security sensitive: no
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
* Reason: persistent domain model and migration

## Scope

### In Scope

* Add Property and Room Type migrations, commands, queries, capability declaration, and module contract in `packages/booking/property`.
* Model Property address, timezone, currency, check-in/out times, and default policy; model Room Type occupancy, beds, amenities, limits, and Media reference.
* Register `packages/booking/*` in the workspace, add the `@storeweave/booking-property` TypeScript alias and lockfile importer, and copy the package manifest in the Docker builder. Cover the alias resolution and builder manifest in their existing root tests. Keep unit coverage under the package's existing `test` glob and PostgreSQL integration coverage under `tests/integration`, already selected by the root integration project.

### Out of Scope

* Room Night, base nightly price, local-date price override, Reservation, media bytes, Content, Admin shell, Theme renderers, and Commerce changes.

## Inputs

* Operator Property and Room Type data; Base Media asset references.

## Outputs

* Readable active Room Types and Property facts for Booking consumers.

## Rules

* R1: A release enables exactly one Property.
* R2: `max_occupancy_per_unit` is a Room Type fact; it is not sellable inventory.
* R3: Store a Media reference only; this module never owns Media bytes or editorial content.
* R4: `booking-availability` owns Room Type base nightly price and every local-date price override; Property exposes no price source of truth.

## Expected Errors

* Reject a second Property, invalid timezone/currency/times, invalid occupancy, and unknown Media references.

## Dependencies

* SW-103 ReleaseDefinition expand.

## Constraints

* Boundary: `packages/booking/property`, the `packages/booking/*` workspace entry, `@storeweave/booking-property` TypeScript alias, lockfile importer, Docker builder manifest entry and their focused tests, plus PostgreSQL integration tests under `tests/integration`. ReleaseDefinition and legacy bundle wiring belongs to SW-103–112. Requires Sol/high design analysis and independent Sol/high review. `defaultPolicy` is the operator-owned number of hours before check-in when self-service full cancellation remains eligible; no refund behavior is implemented here. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Do not touch Commerce tables.
