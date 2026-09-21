# Story: SW-120 Booking Property Theme

## Goal

Provide Booking storefront renderers for Property, Room Type list, and Room Type detail pages.

## Context

B02 proves that a Theme renders Booking page declarations without owning lodging facts.

## Classification

* Security sensitive: no
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
* Reason: public storefront contract

## Scope

### In Scope

* Declare and register the required Property, Room Type list, and Room Type detail Storefront pages in the data-owning `packages/booking/property` module, including the public read queries those pages need.
* Add the Booking Theme and its required renderers in `packages/themes/booking-default`, typed from the page contracts exported by `booking-property`.
* Register the Theme's TypeScript alias, lockfile importer, and Docker builder package manifest so later release assembly can resolve and build it.
* Keep Commerce's B17 semantic provenance scoped to source actually selected by the Commerce Release; update its generated artifact and SW-102's dependent public-contract checksum.

### Out of Scope

* Property data ownership, search/Quote interactions, Nest/server HTTP adapter or controller wiring, shared Theme infrastructure, and Admin UI.

## Inputs

* Booking Property and Room Type facts from SW-119, projected through the declared Booking page models.

## Outputs

* Rendered Booking Property, Room Type list, and detail views.

## Rules

* R1: The Theme only presents declared Booking page data.
* R2: A missing required renderer fails the existing contract check at build/startup.

## Expected Errors

* Reject incomplete or mismatched page-renderer declarations rather than silently rendering a fallback.

## Dependencies

* SW-119 Property and Room Type.

## Constraints

* Boundary: page declarations and public reads in `packages/booking/property`; Theme contract and renderers in `packages/themes/booking-default`; its owned workspace registration in `tsconfig.base.json`, `pnpm-lock.yaml`, and the Docker builder manifest; Commerce-only provenance scope in `scripts/b17-public-contract-semantic.ts` and its generated B17/SW-102 evidence. The Theme imports only the page/view types from Booking and no executable backend, database, or Commerce code. The Theme emits `/booking/media/:mediaAssetId/preview` only for a valid referenced UUID; SW-135 owns the public endpoint and must authorize it against an active Room Type reference. Requires Sol/high design analysis and independent Sol/high review for this public storefront contract.
