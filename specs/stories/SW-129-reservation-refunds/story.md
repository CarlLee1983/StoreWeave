# Story: SW-129 Reservation Refunds

## Goal

Record and execute Reservation refund work with retryable, operator-visible outcomes.

## Context

B11 fulfills the refund path required by Late/Excess payment and later cancellation.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes, Booking database only
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: external financial side effect

## Scope

### In Scope

* Add Reservation refund records, Provider refund invocation, retry, and operator-visible failure evidence in `packages/booking/reservation`.

### Out of Scope

* Provider adapter implementation/UAT, cancellation eligibility, notification delivery, and payment winner logic.

## Inputs

* Refund-required payment evidence, amount/currency, eligible Provider refund capability, and retry schedule.

## Outputs

* Idempotent refund workflow with pending/succeeded/failed evidence.

## Rules

* R1: Full refunds for Late and Excess payment equal actual received amount.
* R2: Refund failure remains visible and retryable; it never restores Reservation state or Room Nights.
* R3: A refundable Booking release selects only a Provider that passes the refund contract.

## Expected Errors

* Reject over-refunds, duplicate completed refunds, mismatched currency, and unsupported/refund-contract-failing providers.

## Dependencies

* SW-116 ECPay refund contract.
* SW-128 Payment Callback Winner.

## Constraints

* Boundary: `packages/booking/reservation` only. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. No local mock may replace ECPay staging refund UAT release gate.
