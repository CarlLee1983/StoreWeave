# Story: SW-140 Property Admin

## Goal

提供 `booking-property` 的 Admin contribution，讓具權限的 operator 管理單一 Property 與 Room Type 結構化事實及 Media reference。

## Context

Property 擁有地址、時區、幣別、入住/退房時間、政策與房型事實；Base Content 不是 Room Type 事實來源。

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

* Level: medium
* Reason: `operator-authorization-and-property-facts`

## Scope

### In Scope

* Add Property/Room Type Admin routes, navigation, permission declarations, UI entry points, and controller/query bindings through the Admin contribution contract.

### Out of Scope

* Property domain persistence/commands, availability/price editing, Reservation operations, Base Content authoring, or a second Property.

## Inputs

* `booking-property` public commands/queries/capabilities and Admin composition contract.

## Outputs

* Build-time Booking Admin contribution for Property and Room Type management.

## Rules

* R1: Direct URLs require backend operator authorization; navigation visibility is not authorization.
* R2: Room Type facts use `max_occupancy_per_unit`, never inventory capacity.
* R3: Media is stored as a Base Media reference; booking-property owns no media bytes.
* R4: First release exposes exactly one Property.

## Expected Errors

* Unauthorized operator, missing Property, invalid timezone/currency/occupancy, duplicate room type, and invalid Media reference yield safe validation/not-found/forbidden outcomes.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K19.

## Dependencies

* SW-108, SW-137.

## Constraints

* Boundary: `booking-property` Admin contribution only. Browser code must not import DB/Nest/migration source; no Commerce route edits.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is an operator-facing authorization boundary.
