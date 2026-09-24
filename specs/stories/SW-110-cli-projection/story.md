# Story: SW-110 CLI projection

## Goal

Resolve product commands through CLI projections supplied by ReleaseDefinition.

## Context

The common CLI must use selected contributions rather than product-id branches and must not load browser/server-only executable code.

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
* Reason: operational command composition

## Scope

### In Scope

* Update CLI command discovery/composition and focused CLI projection tests.

### Out of Scope

* Changing command semantics, config resolution implementation, or adding Booking commands.

## Inputs

* SW-103, SW-104, SW-105, and SW-109.

## Outputs

* CLI command projection selected by release definition.

## Rules

* R1: Product commands are explicitly declared by the selected release.
* R2: CLI artifact imports neither React/Admin source nor server-only provider implementation.

## Expected Errors

* Duplicate command names or missing command contribution fail before dispatch.

## Dependencies

* SW-104, SW-105, SW-109; plan K05.

## Constraints

* Boundary: shared CLI app; retain all existing Commerce command behavior.
