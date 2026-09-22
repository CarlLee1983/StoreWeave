# Story: SW-150 Optional Extension Secrets

## Goal

Let an Extension declare a named secret that it may read when an optional
capability is enabled, without making that secret a mount-time requirement for
deployments that do not use the capability.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Risk

* Level: high
* Reason: Extension secret-access interface

## Scope

### In Scope

* Add a static `optionalSecrets` manifest declaration to the Extension SDK.
* Keep secret reads confined to names declared in either `requiredSecrets` or
  `optionalSecrets`.
* Preserve mount-time failure for missing required secrets while allowing a
  missing optional secret.
* Document the interface and cover host access and mount behaviour.

### Out of Scope

* Dynamic secret names, secrets in configuration, changes to SecretProvider,
  provider-specific refund behaviour, or changing existing required secrets.

## Rules

* R1: A secret name cannot appear in both declaration lists.
* R2: An optional secret never turns a missing-secret health or mount result
  into a failure merely by being declared.
* R3: An Extension cannot read an undeclared secret, even if the provider has
  that value.

## Expected Errors

* An overlapping declaration is rejected as an invalid manifest.
* A missing required secret still rejects mounting.
* Reading an undeclared secret remains forbidden.

## Constraints

* Implementation spans the Extension SDK, Kernel Host, health reporting, and
  their focused tests. It changes a public Interface and therefore requires
  Sol/high design analysis, independent Sol/high review, and `make verify`.
