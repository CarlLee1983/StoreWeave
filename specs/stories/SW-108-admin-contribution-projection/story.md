# Story: SW-108 Admin contribution projection

## Goal

Assemble Admin route, navigation, permission, and UI-entry contributions at build time from the Admin projection.

## Context

Spec 0011 requires product-owned Admin contributions and a product-neutral shared shell; Commerce first enters through one compatible contribution.

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
* Reason: privileged browser composition

## Scope

### In Scope

* Add Admin projection contribution contract and migrate the Admin shell's Commerce entry point.

### Out of Scope

* Booking Admin pages, backend authorization semantics, or generic runtime plugin loading.

## Inputs

* SW-103 ReleaseDefinition and SW-105 Commerce definition.

## Outputs

* Build-time Admin contribution assembly with compatibility-preserving Commerce contribution.

## Rules

* R1: Contributions declare route, navigation, permission, and UI entry together.
* R2: Browser artifact cannot import Nest, DB, migrations, secrets, or provider implementation.
* R3: Shared Admin shell does not branch on release id.

## Expected Errors

* Conflicting routes, invalid permissions, or missing UI entries are rejected before browser build.

## Dependencies

* SW-105; plan K04.

## Constraints

* Boundary: Admin shell/projection app. Requires Sol/high design analysis and independent Sol/high review.
