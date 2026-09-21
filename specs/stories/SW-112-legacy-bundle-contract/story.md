# Story: SW-112 Legacy bundle contract

## Goal

Make ReleaseDefinition projections the only Base and Commerce assembly source, migrate every active runtime/build/CLI consumer, then remove the superseded bundle assembly contract.

## Context

Expand→migrate→contract ends only when there is one ReleaseDefinition assembly source; permanent fallback would violate Spec 0011.

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
* Reason: removal of compatibility assembly path

## Scope

### In Scope

* Move the domain-neutral executable release runtime/bootstrap, build-manifest, and module-contract seams out of `packages/platform/bundle` into target-specific `packages/platform/release` subpaths. Keep the common ReleaseDefinition root manifest-only.
* Make Base and Commerce own their executable assembly in `packages/releases/{base,commerce}` and resolve selected module/theme/extension keys against those registries before invoking target factories.
* Migrate the supported `file-requests` example release to a package-owned runtime definition so removing the old executable contract does not orphan its build or HTTP/Worker flow.
* Migrate API, Worker, CLI, seed, restore, manifest, Admin validation, build aliases, TypeScript defaults, source scanners, and tests away from legacy bundle assembly.
* Delete superseded `packages/platform/bundle` release definitions, Commerce module facade, executable `ReleaseDefinition`, bootstrap, compatibility exports, and tests after the import inventory is empty.
* Preserve Base/Commerce public behavior and build/runtime evidence, and preserve the fixed legacy migration catalog bytes and checksum semantics used by upgrade and restore.

### Out of Scope

* Changes to the serializable ReleaseDefinition manifest semantics, product-domain behavior, Booking release work, database migrations, and live store data.

## Inputs

* SW-104 through SW-111 completion and passing Base/Commerce projection checks.

## Outputs

* One supported assembly source: ReleaseDefinition projections.

## Rules

* R1: Remove superseded types, adapters, branches, and imports together.
* R2: Do not retain a fallback, alias, or compatibility branch.

## Expected Errors

* Any attempted legacy bundle import fails typecheck/contract scanning.

## Dependencies

* SW-111; plan K02–K05.

## Constraints

* Boundary: `packages/platform/release`, `packages/releases/{base,commerce}`, the file-requests example release, runtime/build/CLI consumers and their contract tests, then `packages/platform/bundle` for final deletion. No compatibility alias or old-assembly fallback may remain. Requires Sol/high design analysis and independent Sol/high review of the final removal delta.
