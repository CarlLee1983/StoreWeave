# Story: SW-103 ReleaseDefinition expand

## Goal

Expand `packages/platform/release` with a domain-neutral ReleaseDefinition contract and target-specific projection declarations while existing assembly remains buildable.

## Context

Issue #46, Spec 0011, and ADR 0052 require one logical source for selected modules, theme, extensions, HTTP, Admin, CLI, config, and manifest metadata; ADR 0052 prohibits executable contributions in the common root manifest.

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
* Reason: public ReleaseDefinition interface

## Scope

### In Scope

* Add the additive ReleaseDefinition and projection contract in `packages/platform/release` with its contract tests.

### Out of Scope

* Migrating Base or Commerce assembly consumers, API host, Admin shell, CLI, or build scripts.

## Inputs

* SW-102 baseline and Spec 0011 §7.

## Outputs

* A typed, serializable root manifest contract and independently resolvable target projection interfaces.

## Rules

* R1: Root manifest contains only release identity, selected keys, version, and serializable metadata.
* R2: Projection declarations must not make React, Nest, DB, migrations, secrets, or provider implementations common imports.
* R3: This is expand-only; legacy assembly remains supported until migration stories complete.

## Expected Errors

* Invalid definition, duplicate selected key, or an executable value in root metadata is rejected at contract validation.

## Dependencies

* SW-102; plan K01.

## Constraints

* Boundary: `packages/platform/release`. Requires Sol/high design analysis and independent Sol/high review before completion.
