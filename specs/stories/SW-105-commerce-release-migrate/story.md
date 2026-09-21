# Story: SW-105 Commerce release migrate

## Goal

Migrate Commerce product assembly to its ReleaseDefinition entry point while preserving Commerce compatibility.

## Context

Spec 0011 requires Commerce to keep existing data, migration history, public Command/Query/Event contracts, URLs, and `commerce.yaml` through the assembly refactor.

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
* Reason: compatibility-preserving release migration

## Scope

### In Scope

* Move Commerce release assembly and release tests to `packages/releases/commerce`.

### Out of Scope

* Commerce domain behavior, data migrations, `commerce.yaml` changes, or removal of legacy assembly before SW-112.

## Inputs

* SW-103 ReleaseDefinition contract and SW-102 Commerce baseline.

## Outputs

* Commerce target projections equivalent to the established Commerce release surface.

## Rules

* R1: No common host or platform code branches on the Commerce release id.
* R2: Commerce public contracts, URLs, configuration filename, and migration history remain compatible.

## Expected Errors

* Missing or duplicate Commerce contribution fails assembly with the projection and key identified.

## Dependencies

* SW-103; plan K02.

## Constraints

* Boundary: `packages/releases/commerce`; do not edit domain packages or shared platform contract. Requires Sol/high design analysis and independent Sol/high review.
