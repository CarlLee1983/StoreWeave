# Story: SW-117 Commerce payment migrate

## Goal

Migrate `packages/commerce/order` to the new Provider ABI while preserving all Order-owned payment semantics.

## Context

Provider adapters are shared only at the domain-neutral seam. Commerce continues to own Payment request lifecycle, deferred payment, callback effects, retries, and refunds.

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
* Reason: Commerce payment lifecycle migration

## Scope

### In Scope

* Update `packages/commerce/order` provider calls and regression tests to use SW-113 ABI.

### Out of Scope

* Altering Order state semantics, adapters, Payment ABI cleanup, or Booking payment attempts.

## Inputs

* SW-114, SW-115, and existing Commerce Order payment tests.

## Outputs

* Commerce Order as the final migrated Payment ABI consumer.

## Rules

* R1: Order remains the owner of its payment requests and state-derived Order effects.
* R2: New provider calls use unique reference/displayReference and no Order-shaped provider payload.
* R3: Immediate, deferred, callback, retry, and refund observables stay compatible.

## Expected Errors

* Provider failure, invalid callback, duplicate callback, expired payment, and refund failure retain current distinguishable Order outcomes.

## Dependencies

* SW-114, SW-115; plan K08.

## Constraints

* Boundary: `packages/commerce/order`. Requires Sol/high design analysis and independent Sol/high review of Payment ABI migration delta; no changes to adapter or extension-SDK packages.
