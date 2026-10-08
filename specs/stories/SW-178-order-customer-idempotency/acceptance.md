# Acceptance Criteria

## Customer isolation

* [x] AC-001 / ORD-12: Distinct customers can establish distinct orders with the same raw checkout key and different carts.
* [x] AC-002 / ORD-12: A foreign cart returns the same `NOT_FOUND` for a key used only by the other customer and a fresh key; after the caller uses that key, a different payload may mismatch their own record without returning the other customer's order.
* [x] AC-003 / ORD-12: Same customer, same cart, same key returns the original order without an extra reservation.

## Compatibility

* [x] AC-004: Actor scoping is an opt-in descriptor behavior; unrelated idempotent commands retain their existing namespace and replay behavior.
* [x] AC-005: The transition needs no schema migration; the legacy cart link supports replay of pre-change checkout orders using the new required confirmation input; exact old payloads fail validation as documented in ADR 0054.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| AC-001 | integration test | `tests/integration/order-customer-idempotency.test.ts` ORD-12 | Distinct order IDs and correct owner/lines for each customer |
| AC-002 | integration test | same test | Foreign cart yields equal `NOT_FOUND` messages before the caller uses the key; later mismatch refers only to the caller's own key |
| AC-003 | integration test | same test | Original ID replays; one order and one reservation for that customer |
| AC-004 | focused existing test | `tests/integration/idempotency.test.ts` | Default commands still replay and reject mismatched content as before |
| AC-005 | code and document review | command bus namespace and checkout cart order link; SW-178 story | Existing columns suffice and legacy carts retain their order link |
