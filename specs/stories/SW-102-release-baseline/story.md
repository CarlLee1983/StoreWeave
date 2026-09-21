# Story: SW-102 Release baseline

## Goal

Freeze reproducible Base and Commerce release manifests, target import graphs, and public-contract baselines before the Booking assembly migration.

## Context

Issue #46, Spec 0011, ADR 0052, and implementation-plan K00 require evidence of the current cross-product boundary before ReleaseDefinition or consumer assembly changes.

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
* push: yes
* deploy: no

## Risk

* Level: medium
* Reason: cross-product regression baseline

## Scope

### In Scope

* Add repository-test fixtures or artifacts that snapshot the existing Base and Commerce release surfaces and target import graph.

### Out of Scope

* Changing production release assembly, manifests, public contracts, or product behavior.

## Inputs

* Current Base and Commerce build artifacts and public-contract checks.

## Outputs

* Reproducible baseline evidence used by R01–R10.

## Rules

* R1: Baselines observe current public and artifact boundaries without normalizing drift.
* R2: Baseline artifacts must identify their source revision or deterministic inputs.

## Expected Errors

* A missing target artifact or changed public surface fails the baseline check with the affected release and target.

## Dependencies

* None (no technical Story blocker); plan K00.

## Constraints

* Boundary: repository architecture/release tests only. Do not alter packages, apps, or checked-in production configuration.
