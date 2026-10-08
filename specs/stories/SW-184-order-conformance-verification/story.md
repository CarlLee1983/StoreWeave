# Story: SW-184 Numbered order conformance verification

## Goal

Prove every WebForge order scenario against StoreWeave with a numbered integration test, run the complete verification gate in a clean environment, and send the resulting commit and date to WebForge's known implementation table.

## Context

GitHub issue #124 is the integration checkpoint after issues #117 through #123. The scenario definitions are in WebForge `capabilities/order/scenarios.md`; ORD-19 applies because StoreWeave uses the cart to identify a checkout.

## Scope

### In Scope

* Add numbered coverage for ORD-01, ORD-11, ORD-13, ORD-14, and ORD-19, completing the mapping of ORD-01 through ORD-19.
* Run `make verify` after the prerequisite Stories are integrated and record the exact commit and date of the passing run.
* Update WebForge's StoreWeave scenario mapping and verified maturity evidence after the complete gate passes.

### Out of Scope

* Changing order business behavior during the verification checkpoint.
* Claiming cross-stack verification from a partial or unrun suite.

## Rules

* R1: Each scenario has at least one test whose name begins with its ORD number.
* R2: A replay must assert both response identity and absence of duplicate order or reservation state.
* R3: The complete gate and WebForge report use one identifiable StoreWeave commit and execution date.

## Expected Errors

The same customer's reused raw key with different cart or recipient content yields `IDEMPOTENCY_MISMATCH`. A repeat checkout of an already checked-out cart with a new key resolves to its original order under the cart identity rule.

## Dependencies

Issues #117 through #123 and their corresponding Stories must be integrated before the full gate and external report.

## Constraints

Integration tests use the real PostgreSQL harness. The final evidence is conditional on a clean `make verify` run; a focused pass alone does not complete this Story.
