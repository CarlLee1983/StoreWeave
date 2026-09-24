# Story: SW-104 Base release migrate

## Goal

Migrate Base product assembly to the expanded ReleaseDefinition entry point.

## Context

This is the first consumer migration after SW-103; it proves the new contract can assemble a non-Commerce release without product-name branching.

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
* Reason: release assembly migration

## Scope

### In Scope

* Move Base release definition and its release-level tests to `packages/releases/base`.

### Out of Scope

* Commerce migration, deleting legacy compatibility, or changing Base module behavior.

## Inputs

* SW-103 ReleaseDefinition contract and SW-102 Base baseline.

## Outputs

* Base definition assembled through target projections with baseline-equivalent behavior.

## Rules

* R1: Base owns its selected contributions; platform remains product-neutral.
* R2: The migration preserves existing Base public contracts and configuration behavior.

## Expected Errors

* Missing required Base contribution or incompatible projection fails at build/contract validation.

## Dependencies

* SW-103; plan K02.

## Constraints

* Boundary: `packages/releases/base`; do not modify shared ReleaseDefinition or Commerce files. Requires Sol/high design analysis and independent Sol/high review.
