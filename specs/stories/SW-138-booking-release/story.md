# Story: SW-138 Booking Release

## Goal

建立 `packages/releases/booking` 的 Booking ReleaseDefinition 與 target projections，使 Booking backend/server、Worker、storefront、Theme、Extension、CLI 與 `booking.yaml` 可由單一組裝來源靜態建置。

## Context

K18 需要第一個完整 Booking artifact checkpoint；ADR 0052 禁止共用層以 product id 分支，也禁止 root manifest 攜帶 executable contribution。

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
* Reason: `public-release-definition`

## Scope

### In Scope

* Define Booking release identity, metadata, selected modules, Theme, Payment Extension, config schema/default filename, and backend/server, worker, storefront, and CLI target-specific executable projections.
* Wire completed Booking server, worker, storefront, Theme, Extension, and CLI contributions into their correct targets.

### Out of Scope

* Admin artifact/projection/contribution assembly (SW-143), Platform release contract redesign, Commerce release migration, implementation of Booking modules/contributions, deployment, or production configuration.

## Inputs

* `@storeweave/platform-release` contract; SW-112, SW-118, SW-124, SW-134, and SW-137 outputs; Spec 0011 §7–8.

## Outputs

* Static Booking artifacts and `booking.yaml` declaration built exclusively from the Booking ReleaseDefinition.

## Rules

* R1: Root manifest has identity, selection keys, version, and serializable metadata only.
* R2: Backend/server, worker, and CLI never import React/Admin; storefront only imports its browser-safe executable contributions.
* R3: Contributions are selected at build time; no runtime product installation or release-id switch.
* R4: Missing required backend/server, worker, storefront, CLI, Theme, or Extension contribution fails build/start with its missing key.

## Expected Errors

* Invalid config, duplicate/missing in-scope contribution, target-incompatible import, missing renderer, or unqualified refund provider prevents artifact build/start.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-112, SW-118, SW-124, SW-134, SW-137.

## Constraints

* Boundary: `packages/releases/booking` only, plus its owned release fixtures/tests. No Commerce artifact changes or migrations.
* Sol/high design analysis and independent Sol/high review are required before implementation because ReleaseDefinition is a public assembly contract.
