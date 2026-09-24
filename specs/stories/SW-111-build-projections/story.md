# Story: SW-111 Build projections

## Goal

Make build scripts emit and validate target-specific release projections rather than a universal executable bundle.

## Context

Spec 0011 requires separate static artifacts for Base, Commerce, and Booking, and target isolation must be observable before Booking is introduced.

## Classification

* Security sensitive: no
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
* Reason: build artifact boundary

## Scope

### In Scope

* Update build projection generation and repository artifact-import checks.

### Out of Scope

* Product behavior, new Booking artifacts, or removal of legacy bundle contract.

## Inputs

* SW-103 through SW-110 and SW-102 import baseline.

## Outputs

* Target-specific Base and Commerce build projections with reproducible isolation checks.

## Rules

* R1: Server, worker, Admin browser, and CLI resolve separate executable contributions.
* R2: Build scripts contain no release-id behavior branches.

## Expected Errors

* A forbidden cross-target import or unresolved target projection fails the build check with target and source path.

## Dependencies

* SW-106, SW-107, SW-108, SW-110; plan K05.

## Constraints

* Boundary: repository build scripts/tests; do not remove the legacy bundle contract yet. Requires Sol/high design analysis and independent Sol/high review.
