# Story: SW-115 ECPay Payment migrate

## Goal

Migrate the ECPay adapter to the expanded domain-neutral Provider ABI while retaining callback correlation and existing Commerce payment behavior.

## Context

ECPay must become a provider usable by separate product releases; its adapter cannot carry Order-specific ABI fields.

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
* Reason: external payment callback adapter

## Scope

### In Scope

* Update ECPay payment initiation/callback adapter code and local contract tests for SW-113 ABI.

### Out of Scope

* ECPay refund implementation/UAT (SW-116), Commerce Order migration, or external staging action.

## Inputs

* SW-113 ABI and existing ECPay adapter tests.

## Outputs

* ECPay payment path using unique reference and displayReference without product-domain fields.

## Rules

* R1: Verified callback mapping remains keyed by unique reference.
* R2: Signature verification and callback error mapping remain intact.
* R3: This migration does not claim refund readiness.

## Expected Errors

* Invalid signature, unknown reference, invalid amount, or provider rejection remains distinguishable and non-successful.

## Dependencies

* SW-113; plan K07.

## Constraints

* Boundary: ECPay payment adapter package only. Requires Sol/high design analysis and independent Sol/high review of Payment ABI migration delta.
