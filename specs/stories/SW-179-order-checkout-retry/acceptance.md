# Acceptance Criteria

## Concurrent checkout

* [x] AC-001 / ORD-09: Two customers checking out reversed multi-line carts both complete without a PostgreSQL deadlock when stock covers both.
* [x] AC-002 / ORD-09: Their combined reservations do not exceed on-hand stock.

## Inconclusive checkout

* [x] AC-003 / ORD-18: Three inconclusive reservation attempts yield a temporary `CONFLICT` instead of an unexpected exception.
* [x] AC-004 / ORD-18: Exhaustion leaves no order or reservation and does not consume the idempotency key; the same key succeeds after the injected conflict ends.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| AC-001 | PostgreSQL integration test | `tests/integration/order-checkout-retry.test.ts` ORD-09 | Both reversed-line checkouts fulfill; baseline before lock sorting reproduced `40P01` |
| AC-002 | same test | stock queries | Each product has on hand 2, reserved 2, available 0 |
| AC-003 | PostgreSQL integration test | same file, ORD-18 | Three injected inconclusive reserve attempts produce expected temporary error |
| AC-004 | same test | order and stock queries, same-key retry | No rows or reservations after failure; one order after retry |
