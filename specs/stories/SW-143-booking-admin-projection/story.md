# Story: SW-143 Booking Admin Projection

## Goal

把 Booking 的 Property、Availability、Reservation Admin contributions 組成 Browser-only Booking Admin target projection，並在組裝時驗證缺漏。

## Context

ReleaseDefinition 的 target projection 是 Admin route/navigation/permission/UI entry 的唯一組裝來源；不得保留第二套路由來源。

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
* Reason: `admin-target-boundary`

## Scope

### In Scope

* Define/consume the Booking Admin target projection and validate its route, navigation, permission, and UI entry contribution keys at build/start.

### Out of Scope

* Individual module Admin UI behavior, server controllers, global Admin shell redesign, Commerce contribution migration, or release contract redesign.

## Inputs

* Admin projection contract, Booking ReleaseDefinition, and SW-140–SW-142 contributions.

## Outputs

* A statically composed Booking Admin browser artifact with missing/duplicate contribution diagnostics.

## Rules

* R1: Browser projection imports only browser-safe executable contributions.
* R2: Contributions are build-time selected; the shell does not branch on Booking release id.
* R3: Direct route access stays protected by each server endpoint; navigation permissions are presentation only.
* R4: Required contribution absence/duplication fails deterministically with keys listed.

## Expected Errors

* Target-incompatible import, missing/duplicate route or UI entry, invalid permission declaration, and stale projection key fail build/start.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K19.

## Dependencies

* SW-138, SW-142.

## Constraints

* Boundary: Booking Admin projection/release integration only. No module domain changes, server code import, or Commerce route changes.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is an Admin target architecture boundary.
