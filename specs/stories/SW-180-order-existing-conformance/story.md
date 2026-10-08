# Story: SW-180 Existing order conformance evidence

## Goal

Prove the existing order snapshot, atomic reservation, concurrency, and replay behavior against WebForge order scenarios ORD-02 and ORD-06 through ORD-10.

## Context

GitHub issue #120 identifies these implemented or partially tested behaviors as missing integration evidence. The scenario definitions live in WebForge `capabilities/order/scenarios.md`.

## Scope

### In Scope

* Add a real PostgreSQL integration suite for ORD-02 and ORD-06 through ORD-10.
* Name each test with its scenario number and assert the observable order and stock state.

### Out of Scope

* Changing order, cart, catalog, or inventory production behavior.
* Fixing any failed conformance scenario in this Story; record the failure as a separate issue.

## Rules

* R1: Use distinct customers and carts for competing checkout attempts.
* R2: A rejected checkout leaves no order and no extra reservation.
* R3: Snapshot and replay assertions read the original order after intervening changes.

## Expected Errors

Insufficient stock rejects the affected cart checkout with `VALIDATION_ERROR`; concurrent losers do not leave partial state.

## Dependencies

None.

## Constraints

Boundary: integration tests for Commerce order behavior. Verification uses the repository PostgreSQL harness and `make verify` remains the completion gate.
