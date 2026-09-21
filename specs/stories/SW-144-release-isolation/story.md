# Story: SW-144 Release Isolation

## Goal

建立 repository-level structural checks，證明 Booking、Commerce、Base 的 static artifacts 與各 target executable import 保持隔離。

## Context

ADR 0052 的可證偽條件要求 Booking 不依賴 Commerce implementation，Platform/Base 不出現產品分支，且 target projections 不夾帶錯誤 runtime。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
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
* Reason: `cross-product-and-target-isolation`

## Scope

### In Scope

* Add repository architecture/import checks and fixtures for product artifact isolation, target isolation, root-manifest executability, and product-branch prohibitions in common assembly code.

### Out of Scope

* Changing release/module behavior, moving Commerce packages, modifying Booking domain, or runtime deployment testing.

## Inputs

* ReleaseDefinitions/projections and repository import-graph/architecture-test harness.

## Outputs

* Executable isolation evidence that fails on forbidden product or target imports.

## Rules

* R1: Booking backend/worker/browser artifacts exclude Commerce implementation; Booking clean database excludes Commerce tables.
* R2: server/worker/CLI exclude React/Admin; Admin excludes Nest/DB/migration/secret/provider implementation; worker excludes HTTP controllers.
* R3: Common Platform/Base release assembly has no `booking`/`commerce` behavior branch.
* R4: Root manifests are serializable metadata only.

## Expected Errors

* A synthetic forbidden import, executable root-manifest member, product-id switch, or Commerce table/migration leakage makes the structural check fail with its path/rule.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K20.

## Dependencies

* SW-139, SW-143.

## Constraints

* Boundary: repository integration/architecture tests only. Do not refactor product implementations to satisfy the check.
* Sol/high design analysis and independent Sol/high review are required before implementation because this protects cross-product and target architecture boundaries.
