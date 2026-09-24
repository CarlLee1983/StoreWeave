# Story: SW-109 Release config

## Goal

Move release configuration schema and default configuration filename selection behind ReleaseDefinition.

## Context

Commerce must retain `commerce.yaml`; Booking will use `booking.yaml`; shared utilities must not guess product behavior from a release id.

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

* Level: medium
* Reason: deployment configuration compatibility

## Scope

### In Scope

* Update release configuration resolution and tests in the configuration boundary.

### Out of Scope

* Changing Commerce configuration schema or values, adding Booking configuration, or CLI command migration.

## Inputs

* SW-103 and current Commerce configuration contract.

## Outputs

* Release-declared schema and default filename resolution.

## Rules

* R1: Configuration filename and schema come from the selected definition, not a shared product-id switch.
* R2: `commerce.yaml` remains the Commerce default and compatible.

## Expected Errors

* No selected definition, missing config contribution, or invalid config fails with the release and schema identified.

## Dependencies

* SW-104, SW-105; plan K05.

## Constraints

* Boundary: `packages/platform/config` only; no product config value changes.
