# Story: SW-141 Availability Admin

## Goal

提供 `booking-availability` 的 Admin contribution，讓 operator 管理逐日 sellable units 與 nightly price 覆寫並檢視房況。

## Context

Room Night 是 `(room_type_id, local_date)` 的供應與價格擁有者；sellable units 不得低於已 reserved units。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
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
* Reason: `availability-integrity`

## Scope

### In Scope

* Add availability calendar/list routes, permission/navigation/UI contributions, validated daily sellable-unit and price override actions, and authorized availability queries.

### Out of Scope

* Availability locking/persistence algorithms, quote storefront, Room Type facts, Reservation cancellation, or dynamic pricing.

## Inputs

* `booking-availability` commands/queries and Property timezone/currency capability.

## Outputs

* Build-time Admin contribution for daily availability and price administration.

## Rules

* R1: Dates render and validate in the Property timezone; money uses its single configured currency and integer minor units.
* R2: UI labels distinguish `sellable_units`, `reserved_units`, and Room Type `max_occupancy_per_unit`.
* R3: The domain command remains authority for the `sellable_units >= reserved_units` invariant.
* R4: Direct URL backend authorization is mandatory.

## Expected Errors

* Unauthorized access, invalid local date/range/money, missing Room Type, and attempted reduction below reserved units are observable safe errors.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K19.

## Dependencies

* SW-121, SW-140.

## Constraints

* Boundary: `booking-availability` Admin contribution only. No direct table access, migration, or Commerce inventory reuse.
* Sol/high design analysis and independent Sol/high review are required before implementation because operator changes can affect sellable inventory integrity.
