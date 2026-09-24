# Story: SW-118 Payment ABI contract

## Goal

Remove the superseded Order-specific Provider ABI after adapters and Commerce have migrated, leaving one domain-neutral contract and no fallback.

## Context

Spec 0011 mandates expand→migrate→contract and prohibits permanent compatibility paths once all existing consumers use the new ABI.

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
* Reason: public payment ABI cleanup

## Scope

### In Scope

* Remove old Order-specific Provider ABI, compatibility branches, and contract-ledger entries from `packages/platform/extension-sdk`.

### Out of Scope

* Changing migrated adapter behavior, Commerce Order behavior, or implementing Booking consumers.

## Inputs

* SW-114, SW-115, SW-116, SW-117 and passing ABI/consumer contract evidence.

## Outputs

* One supported neutral Provider/refund ABI with no legacy consumer path.

## Rules

* R1: Remove obsolete exported types, adapters, branches, and fixtures together.
* R2: No alias, fallback, or Order-specific input may remain in the public Provider surface.
* R3: Provider/refund contract coverage remains executable after cleanup.

## Expected Errors

* Any old ABI import or payload is rejected by typecheck and contract tests.

## Dependencies

* SW-116, SW-117; plan K09.

## Constraints

* Boundary: `packages/platform/extension-sdk`. Requires Sol/high design analysis and independent Sol/high review of cleanup delta; do not modify consumer packages.
