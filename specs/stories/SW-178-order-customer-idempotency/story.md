# Story: SW-178 Customer scoped checkout idempotency

## Goal

Let different customers use the same raw checkout idempotency key independently, while retaining replay for each customer and hiding another customer's cart and order.

## Context

GitHub issue #118 covers WebForge order scenario ORD-12. The command bus currently persists a `(command_name, key)` idempotency record. Checkout already identifies repeat submissions by its cart's order link.

## Scope

### In Scope

* Opt the checkout command into actor scoped idempotency and prove ORD-12 through a real PostgreSQL integration test.
* Preserve same customer replay and the existing foreign cart `NOT_FOUND` response.
* Keep other command descriptors on their existing idempotency namespace.

### Out of Scope

* Changing the idempotency semantics of all commands or the database schema.
* Changing order identity away from the existing cart fallback.

## Rules

* R1: Two customers with equal raw keys and distinct carts may each establish an order.
* R2: Before using their own key, a customer presenting another customer's cart receives the same `NOT_FOUND` result whether that key was used by the other customer or is fresh. After their own different checkout has used the key, their own idempotency mismatch may take precedence.
* R3: The same customer replaying the same cart and key receives the original order and makes no additional reservation.

## Expected Errors

Foreign carts return `NOT_FOUND` when the caller has not used the key, without exposing the other customer's cached response or key use. A caller's own key reused with different checkout content returns an idempotency mismatch, including when that content names a foreign cart.

## Dependencies

None.

## Constraints and transition

The command bus stores actor scoped records under an encoded `(command, actor)` namespace in the existing `command_name` column, so no schema migration is required. Existing unscoped checkout records remain; new-shaped requests with mandatory price and shipping confirmations resolve their carts to the original order through the cart's order link even when the new namespace misses the legacy record. Exact pre-deployment payloads without confirmations fail input validation; clients must refresh, and existing orders remain available through authenticated order queries. Other commands retain their stored namespaces. Rolling back the checkout opt-in returns the former global key behavior; deployment rollback therefore also withdraws the ORD-12 guarantee until the fix is restored. No historical idempotency rows need rewriting.
