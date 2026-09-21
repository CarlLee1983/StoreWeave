# Story: SW-107 Worker projection

## Goal

Build worker runtime composition exclusively from ReleaseDefinition worker projections.

## Context

Worker contributions are executable target-specific code and must not arrive through a common manifest or import HTTP/Admin source.

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
* Reason: asynchronous runtime composition

## Scope

### In Scope

* Update the worker bootstrap/projection app and targeted composition tests.

### Out of Scope

* Worker job semantics, HTTP mounting, Admin contributions, or new Booking workers.

## Inputs

* SW-103 through SW-105 definitions and existing worker bootstrap.

## Outputs

* A worker artifact assembled only from selected worker contributions.

## Rules

* R1: Worker has no HTTP-controller or Admin UI executable imports.
* R2: Existing Commerce worker behavior is preserved.

## Expected Errors

* Missing worker contribution or an invalid target contribution fails before job execution.

## Dependencies

* SW-104, SW-105; plan K03.

## Constraints

* Boundary: worker projection app; do not alter product module jobs.
