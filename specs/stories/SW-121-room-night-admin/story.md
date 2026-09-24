# Story: SW-121 Room Night Administration

## Goal

Manage per-date Room Night sellable units and nightly-price overrides.

## Context

B03 establishes Availability-owned daily supply and pricing administration before quoting or reservation holds.

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
* Reason: persistent availability invariant

## Scope

### In Scope

* Add Room Night storage, Room Type base nightly-price administration, local-date override administration, and Availability commands/queries in `packages/booking/availability`.
* Register the new workspace package through its TypeScript alias, pnpm lockfile importer, and Docker builder manifest so the package typechecks and satisfies frozen workspace builds.

### Out of Scope

* Admin shell contributions, Quote, Reservation holds, Property ownership, and Theme work.

## Inputs

* Room Type capability, Property-local dates, sellable-unit values, and optional nightly-price overrides.

## Outputs

* Room Night administration results and daily availability/pricing data.

## Rules

* R1: A Room Night is unique by `(room_type_id, local_date)`.
* R2: `sellable_units` must never be lower than `reserved_units`.
* R3: Availability owns the Room Type base nightly price and every local-date price override; the base price applies when no override exists.
* R4: Room Night administration uses Property-local canonical `YYYY-MM-DD` dates and a half-open range; a single update is limited to 366 dates.
* R5: Money is an integer number of the Property currency's minor units. An omitted override preserves the current value; explicit `null` clears it.

## Expected Errors

* Reject invalid date ranges, negative units/prices, unknown Room Types, and reductions below reserved units.

## Dependencies

* SW-119 Property and Room Type.

## Constraints

* Boundary: Availability domain code and migrations in `packages/booking/availability`, plus its package-only TypeScript alias, frozen-lockfile importer, Docker manifest registration, and regression evidence. Do not edit sibling product modules or build the Booking Release. Requires Sol/high design analysis and independent Sol/high review. Use Property local dates; migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. No Reservation table access or cross-module foreign keys.
