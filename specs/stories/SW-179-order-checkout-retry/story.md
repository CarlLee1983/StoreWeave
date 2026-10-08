# Story: SW-179 Bounded checkout retry and lock order

## Goal

Resolve inconclusive checkout writes with a bounded retry and a temporary error, and prevent reversed multi-line checkouts from deadlocking over inventory rows.

## Context

GitHub issue #119 covers WebForge ORD-18 and the concurrent part of ORD-09. A real PostgreSQL integration test with reversed cart lines and a barrier after each transaction's first reservation reproduced SQLSTATE `40P01` before changing lock order.

## Scope

### In Scope

* Acquire inventory reservations in stable product order for checkout.
* Retry only classified transaction-aborted or inconclusive reservation outcomes with a fixed limit.
* Return a temporary, expected checkout error when attempts are exhausted; let the same key be retried later.
* Test both cases against the real PostgreSQL harness.

### Out of Scope

* Retrying uncertain connection failures that might have committed.
* Changing inventory stock calculations, payment processing, or unrelated commands.

## Rules

* R1: Product lock order is independent of cart line order.
* R2: A retry starts a fresh transaction; failed attempts leave no order, reservation, or claimed idempotency key.
* R3: Only a diagnosed inconclusive or known aborted transaction is retried. A confirmed shortage remains a rejection.

## Expected Errors

When all attempts remain inconclusive, checkout reports `CONFLICT` with a temporary handling message instructing the caller to retry using the original key. A confirmed shortage keeps the normal line rejection.

## Dependencies

None.

## Constraints

The descriptor opts into the bounded transaction retry; other commands retain their existing transaction behavior. No schema migration is needed. Rolling back the descriptor and stable lock order restores the prior checkout behavior and reopens the observed `40P01` risk, so rollback should be paired with disabling affected concurrent checkout traffic or a follow-up fix.
