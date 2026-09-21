# Story: SW-113 Payment ABI expand

## Goal

Expand `packages/platform/extension-sdk` with a domain-neutral Payment Provider ABI and executable contract tests while Order-specific consumers remain temporarily supported.

## Context

ADR 0052 requires provider input limited to unique `reference`, `displayReference`, `amount`, `currency`, and `method`; Commerce and Booking retain their own payment-attempt behavior.

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
* Reason: public payment extension ABI

## Scope

### In Scope

* Add the new provider and refund contract to `packages/platform/extension-sdk` with backward-compatible transition support.

### Out of Scope

* Migrating mock, ECPay, or Commerce Order consumers; implementing Booking payment attempts.

## Inputs

* SW-102 baseline, Spec 0011 §6/§8, ADR 0052.

## Outputs

* Domain-neutral payment/refund ABI and contract ledger.

## Rules

* R1: Provider ABI contains no `Order` or `Reservation` field or type.
* R2: New ABI is additive until all existing consumers migrate.
* R3: Refund capability is explicitly contract-tested, not inferred from an unsupported response.

## Expected Errors

* Missing required reference, invalid amount/currency, duplicate reference, or unsupported/failed refund is represented by the provider contract.

## Dependencies

* SW-102; plan K06.

## Constraints

* Boundary: `packages/platform/extension-sdk`. Requires Sol/high design analysis and independent Sol/high review.
