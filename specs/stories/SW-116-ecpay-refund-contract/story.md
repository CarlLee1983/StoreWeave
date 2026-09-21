# Story: SW-116 ECPay refund contract

## Goal

Implement and verify ECPay's shared refund contract so a refundable Booking release can select it only after local evidence and external staging UAT gate evidence exist.

## Context

Spec 0011 explicitly says the current `unsupported` ECPay refund behavior cannot satisfy a refundable Booking Cancellation Policy; staging refund UAT is a release gate, not replaceable by mocks.

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
* Reason: external financial refund contract

## Scope

### In Scope

* Add ECPay refund implementation, local contract tests, and a documented external staging-UAT evidence requirement.

### Out of Scope

* Performing merchant/staging UAT, production refunds, Booking Reservation workflows, or Commerce payment migration.

## Inputs

* SW-113 refund ABI, SW-115 ECPay payment migration, ECPay provider documentation/credentials supplied through approved channels.

## Outputs

* Locally contract-tested ECPay refund behavior plus a blocking staging-UAT release-gate record format.

## Rules

* R1: Supported, rejected, and indeterminate provider outcomes remain distinguishable.
* R2: Refund request is correlated to the original provider reference and must not fabricate success.
* R3: Local tests do not satisfy the external ECPay staging-UAT release gate.

## Expected Errors

* Invalid credentials/signature, unknown transaction, amount rejection, duplicate request, timeout, and provider failure produce auditable non-success outcomes.

## Dependencies

* SW-115; plan K07.

## Constraints

* Boundary: ECPay adapter package. Requires Sol/high design analysis and independent Sol/high review; external UAT is explicitly out of scope and remains a blocker to release-gate clearance.
