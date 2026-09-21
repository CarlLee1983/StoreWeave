# Story: SW-114 Mock Payment migrate

## Goal

Migrate the mock Payment adapter to the expanded domain-neutral Provider ABI.

## Context

The mock adapter is the first executable provider consumer and must demonstrate the new initiate/callback/refund contract without changing Commerce behavior.

## Classification

* Security sensitive: yes
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
* Reason: payment adapter migration

## Scope

### In Scope

* Update the mock-payment adapter and its contract tests to consume SW-113 ABI.

### Out of Scope

* ECPay, Commerce Order migration, deleting legacy ABI, or Booking behavior.

## Inputs

* SW-113 Provider ABI and current mock adapter contract tests.

## Outputs

* Mock adapter conforming to domain-neutral payment and refund ABI.

## Rules

* R1: Callback correlation uses the unique provider reference.
* R2: Adapter does not reintroduce Order/Reservation semantics.
* R3: Refund behavior satisfies the shared executable contract.

## Expected Errors

* Unknown/duplicate reference and invalid or unavailable refund yield a contract-defined failure, never a fabricated success.

## Dependencies

* SW-113; plan K07.

## Constraints

* Boundary: mock-payment package only. Requires Sol/high design analysis and independent Sol/high review of Payment ABI migration delta.
