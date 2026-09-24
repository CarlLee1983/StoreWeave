# Story: SW-106 API server projection

## Goal

Make the API host mount only server-projection HTTP adapter contributions selected by ReleaseDefinition.

## Context

ADR 0052 requires an API host with no release-id behavior branch and forbids worker/Admin executable imports in the server path.

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
* Reason: public HTTP composition

## Scope

### In Scope

* Update the API host/server adapter composition boundary and its tests.

### Out of Scope

* New Booking endpoints, controller behavior changes, worker projection, or Admin UI migration.

## Inputs

* SW-103 through SW-105 definitions and existing API-host routes.

## Outputs

* Server-only HTTP mounting selected by release projection.

## Rules

* R1: Only explicit adapter contributions may expose REST endpoints.
* R2: The server path imports neither Admin UI nor worker executable contributions.
* R3: No generic REST exposure of Commands is introduced.

## Expected Errors

* Missing server adapter or duplicate route contribution fails startup/build with the owning release identified.

## Dependencies

* SW-104, SW-105; plan K03.

## Constraints

* Boundary: API host/server projection app. Requires Sol/high design analysis and independent Sol/high review.
