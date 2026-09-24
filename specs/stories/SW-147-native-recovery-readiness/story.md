# Story: SW-147 Native recovery readiness

## Goal

Make the native full-recovery smoke wait for the recreated PostgreSQL container
from the release container that will execute `restore`.

## Context

PR #92's CI run completed the backup and replaced PostgreSQL, then the native
Commerce recovery failed with `ECONNREFUSED` while the release CLI connected to
the replacement database. The database-local readiness probe did not cover the
release container's Docker DNS and network path.

## Classification

* Security sensitive: no
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: yes
* push: no
* deploy: no

## Risk

* Level: low
* Reason: CI-only cold-recovery readiness boundary

## Scope

### In Scope

* Native full-recovery smoke database readiness probe.
* Focused regression coverage for the readiness-to-restore ordering.

### Out of Scope

* Release runtime, backup/restore semantics, Docker smoke, workflow topology,
  or PR #92 documentation.

## Inputs

* PR #92 CI job `smoke native (commerce)`.
* Existing native full-recovery smoke and unit smoke-script checks.

## Outputs

* A release-container database readiness probe immediately before native
  restore.

## Rules

* R1: The smoke must still recreate PostgreSQL before recovery.
* R2: Readiness must be tested from the same native release container and
  service identity that executes restore.
* R3: The probe must precede restore and retain the existing bounded timeout.

## Expected Errors

* If the recreated database is unreachable from the release container within
  the timeout, the smoke fails with a reachability-specific error.

## Dependencies

* None.
