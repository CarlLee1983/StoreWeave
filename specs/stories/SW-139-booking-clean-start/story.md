# Story: SW-139 Booking Clean Start

## Goal

驗證 Booking Release 能以乾淨、獨立資料庫套用自己的 migrations 並啟動所選 target，而不建立或讀取 Commerce 資料。

## Context

Booking 是獨立 Product Release；Spec 0011 明確禁止 Commerce-to-Booking 資料遷移與共享資料庫。

## Classification

* Security sensitive: no
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: medium
* Reason: `release-bootstrap-isolation`

## Scope

### In Scope

* Add repository integration fixture/test that boots Booking from an empty database using its release manifest and verifies its migration ownership and start path.

### Out of Scope

* Authoring Booking domain migrations, altering Commerce migrations/data, deploying a database, or implementing HTTP/Admin behavior.

## Inputs

* Completed Booking ReleaseDefinition, Booking migration manifests, and testcontainers integration harness.

## Outputs

* Reproducible clean-start evidence for a Booking database.

## Rules

* R1: Fixture begins with a fresh database and uses `booking.yaml`.
* R2: Only Booking/Base/Platform migrations selected by Booking may run.
* R3: No Commerce table, migration, configuration, or implementation is a bootstrap prerequisite.

## Expected Errors

* Missing Booking config/migration, duplicate manifest, wrong database selection, or Commerce migration leakage fails the fixture with actionable evidence.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-111, SW-138.

## Constraints

* Boundary: repository integration test/docs only. The test must not alter production databases or broaden migration contracts.
* Rollback: discard the ephemeral test database/container; no production or Commerce migration history is changed.
* Sol/high design analysis and independent Sol/high review are required before implementation because clean-start migration isolation is an architecture boundary.
