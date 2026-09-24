# Story: SW-151 Booking Quote Signer Runtime Seam

## Goal

Provide the Booking Availability Quote capability with the configured signing
Keyring at runtime, while keeping Release build projections free of secrets.

## Classification

* Security sensitive: yes
* Baseline conformance: yes
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
* Reason: signing-secret flow across Release and Runtime boundaries

## Scope

### In Scope

* Supply the existing configured signing Keyring to the Booking Availability
  Quote capability after runtime secret resolution.
* Keep build manifests and target projections constructible without signing
  material.
* Fail startup before serving Quotes when the required key is unavailable or
  invalid.

### Out of Scope

* A second secret source, ambient environment lookup, new signing algorithm,
  or changes to Commerce signing behavior.

## Dependencies

* SW-122. This Story must complete before SW-138 wires the production Quote.

## Constraints

* Implement docs/tickets/104-booking-quote-signer-runtime-seam.md at its owning
  runtime boundary. Keep the signer purpose scoped to `booking-quote`.
* Sol/high design analysis and independent Sol/high review are required.
* Run focused Platform/runtime tests and `make verify`.
